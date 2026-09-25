// Proxy pools: resolution precedence, rotation, the strict/fallback decision, the
// migration off the old multi-URL shape, and the health check.
//
// The health check is exercised against a real HTTP proxy built in-process, because the
// bug it replaces (fetching the proxy URL itself, which undici refuses when it carries
// credentials) is invisible to any test that stubs the fetch.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { resolveNodeProxy, pickProxyPoolId, resetProxyRotation, poolUrl, poolStrict } from "../core/proxy.mjs";
import { MIGRATIONS } from "../db/migrations.mjs";

let tmp, db, repos, node;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pools-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  resetProxyRotation();
});

afterEach(() => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const addPool = (name, url, extra = {}) =>
  repos.proxyPools.create({ name, config: { url, strict: extra.strict, ...extra.config } });

describe("pool shape", () => {
  it("reads the url and treats strict as opt-out", () => {
    const p = addPool("p1", "http://user:pass@proxy.example:8080");
    expect(poolUrl(p)).toBe("http://user:pass@proxy.example:8080");
    expect(poolStrict(p)).toBe(true); // default: fail rather than leak the real address
    const loose = addPool("p2", "http://proxy.example:8080", { strict: false });
    expect(poolStrict(loose)).toBe(false);
  });

  it("rejects a url-less pool as unusable", () => {
    const empty = repos.proxyPools.create({ name: "empty", config: {} });
    expect(poolUrl(empty)).toBeNull();
  });
});

describe("resolution precedence", () => {
  it("uses the key's own pool before the provider's", () => {
    const providerPool = addPool("provider", "http://provider.example:1111");
    const keyPool = addPool("key", "http://key.example:2222");
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [providerPool.id], strategy: "none" } } });
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x", proxyPoolId: keyPool.id } });

    const resolved = resolveNodeProxy(repos, repos.nodes.get(node.id), conn);
    expect(resolved.poolId).toBe(keyPool.id);
    expect(resolved.source).toBe("key");
  });

  it("falls back to the provider setting when the key's pool is gone", () => {
    const providerPool = addPool("provider", "http://provider.example:1111");
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [providerPool.id], strategy: "none" } } });
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x", proxyPoolId: "deleted-pool-id" } });

    const resolved = resolveNodeProxy(repos, repos.nodes.get(node.id), conn);
    expect(resolved.poolId).toBe(providerPool.id);
    expect(resolved.source).toBe("provider");
  });

  it("resolves nothing when neither is configured", () => {
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x" } });
    expect(resolveNodeProxy(repos, repos.nodes.get(node.id), conn)).toBeNull();
  });

  it("ignores a disabled pool", () => {
    const p = addPool("off", "http://proxy.example:8080");
    repos.proxyPools.update(p.id, { enabled: false });
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "none" } } });
    expect(resolveNodeProxy(repos, repos.nodes.get(node.id), null)).toBeNull();
  });
});

describe("rotation across pools", () => {
  it("round-robins per provider, and random stays in range", () => {
    const ids = ["a", "b", "c"];
    const picked = [0, 1, 2, 3].map(() => pickProxyPoolId(ids, "round-robin", "prov1"));
    expect(picked).toEqual(["a", "b", "c", "a"]);
    // a different provider keeps its own position
    expect(pickProxyPoolId(ids, "round-robin", "prov2")).toBe("a");
    for (let i = 0; i < 20; i++) expect(ids).toContain(pickProxyPoolId(ids, "random", "prov1"));
  });

  it("rotates the pool used across requests", () => {
    const p1 = addPool("p1", "http://one.example:1111");
    const p2 = addPool("p2", "http://two.example:2222");
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p1.id, p2.id], strategy: "round-robin" } } });
    const n = repos.nodes.get(node.id);
    const seen = [0, 1, 2, 3].map(() => resolveNodeProxy(repos, n, null).poolId);
    expect(seen).toEqual([p1.id, p2.id, p1.id, p2.id]);
  });

  it("uses every enabled pool when none is picked explicitly", () => {
    const p1 = addPool("p1", "http://one.example:1111");
    const p2 = addPool("p2", "http://two.example:2222");
    repos.nodes.update(node.id, { data: { proxy: { strategy: "round-robin" } } });
    const n = repos.nodes.get(node.id);
    const seen = new Set([0, 1, 2, 3].map(() => resolveNodeProxy(repos, n, null).poolId));
    expect(seen).toEqual(new Set([p1.id, p2.id]));
  });
});

describe("migration off the multi-url shape", () => {
  it("splits a legacy pool into one pool per url, keeping the original's id", async () => {
    // A database as the old release left it: schema v3, pools holding urls[]. Built with
    // node:sqlite directly, because openDatabase() migrates on open.
    const { DatabaseSync } = await import("node:sqlite");
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-legacy-"));
    const legacy = new DatabaseSync(path.join(legacyDir, "routy.db"));
    legacy.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) legacy.exec(m.up);
    legacy.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '3')`).run();
    const now = new Date().toISOString();
    legacy.prepare(`INSERT INTO proxy_pools (id, name, kind, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("pool-legacy", "old", "static", JSON.stringify({ urls: ["http://a.example:1", "http://b.example:2"] }), 1, now, now);
    legacy.close();

    // openDatabase() runs the migration chain, which is the path a real upgrade takes
    const reopened = openDatabase(legacyDir);
    const rows = reopened.prepare(`SELECT id, name, config FROM proxy_pools ORDER BY name`).all();
    const configs = rows.map((r) => JSON.parse(r.config));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(["old", "old 2"]);
    expect(configs.map((c) => c.url).sort()).toEqual(["http://a.example:1", "http://b.example:2"]);
    // the original keeps its identity so existing bindings still resolve
    expect(rows.find((r) => r.id === "pool-legacy")).toBeTruthy();
    expect(configs.every((c) => c.urls === undefined)).toBe(true);
    reopened.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }, 20_000);
});

describe("health check through the proxy", () => {
  /** A real forward proxy: authenticates, then either forwards (plain HTTP) or tunnels. */
  function startProxy({ requireAuth = null, refuse = false } = {}) {
    const expected = requireAuth ? "Basic " + Buffer.from(requireAuth).toString("base64") : null;
    const authed = (req) => !expected || req.headers["proxy-authorization"] === expected;

    const server = http.createServer((req, res) => {
      if (!authed(req)) return res.writeHead(407).end();
      if (refuse) return res.writeHead(502).end();
      // plain HTTP through a proxy: the absolute target sits in the request line
      let target;
      try {
        target = new URL(req.url);
      } catch {
        return res.writeHead(400).end();
      }
      const upstream = http.request(
        { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
    });

    server.on("connect", (req, clientSocket, head) => {
      if (!authed(req)) {
        clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        return clientSocket.end();
      }
      if (refuse) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return clientSocket.end();
      }
      const [host, port] = req.url.split(":");
      const upstream = net.connect(Number(port) || 443, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.end());
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
  }

  let origin, proxyServer;
  beforeEach(async () => {
    // a stand-in for the test host, reached THROUGH the proxy
    origin = await new Promise((resolve) => {
      const s = http.createServer((req, res) => res.writeHead(200).end());
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
  });
  afterEach(() => {
    proxyServer?.close();
    origin?.close();
  });

  it("reports a working authenticated proxy as reachable", async () => {
    const { testProxyUrl } = await import("../core/proxy.mjs");
    const started = await startProxy({ requireAuth: "buffrelay1:buffrelaypass" });
    proxyServer = started.server;
    const url = `http://buffrelay1:buffrelaypass@127.0.0.1:${started.port}`;
    const result = await testProxyUrl(url, { testUrl: `http://127.0.0.1:${origin.address().port}/` });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  }, 20_000);

  it("surfaces the real cause when the proxy refuses", async () => {
    const { testProxyUrl } = await import("../core/proxy.mjs");
    const started = await startProxy({ refuse: true });
    proxyServer = started.server;
    const result = await testProxyUrl(`http://127.0.0.1:${started.port}`, { testUrl: `http://127.0.0.1:${origin.address().port}/` });
    expect(result.ok).toBe(false);
    expect(String(result.error)).not.toBe(""); // a reason, not a bare failure
  }, 20_000);

  it("rejects credentials the proxy does not accept", async () => {
    const { testProxyUrl } = await import("../core/proxy.mjs");
    const started = await startProxy({ requireAuth: "right:creds" });
    proxyServer = started.server;
    const result = await testProxyUrl(`http://wrong:creds@127.0.0.1:${started.port}`, { testUrl: `http://127.0.0.1:${origin.address().port}/` });
    expect(result.ok).toBe(false);
  }, 20_000);
});
