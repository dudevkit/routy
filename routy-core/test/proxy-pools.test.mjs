// Proxy pools: fleet shape, resolution precedence, rotation across exits, per-exit health
// (cooldown, Retry-After, the provider-wide exception), merge, the migrations, and the
// health check.
//
// The health check is exercised against a real HTTP proxy built in-process, because the bug
// it replaces (fetching the proxy URL itself, which undici refuses when it carries
// credentials) is invisible to any test that stubs the fetch. The same is true of the
// egress-address reading: only a real round trip proves the reply is parsed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import {
  classifyProxyFailure, closeProxyAgents, entryHealth, forgetExitHealth, isExitAvailable, parseEgressIp,
  poolExits, poolStrict, poolUsable, proxyIdentity, recordExitFailure, recordExitSuccess,
  resetPoolHealth, resetProxyRotation, resolveNodeProxy, testProxyUrl,
} from "../core/proxy.mjs";
import { MIGRATIONS } from "../db/migrations.mjs";

let db, repos, node;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrate(db);
  repos = createRepos(db);
  node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: "http://127.0.0.1:45999/v1" });
  resetProxyRotation();
});

afterEach(async () => {
  // A check leaves a ProxyAgent with a live socket to a proxy that is about to be closed;
  // parked agents surface later as an unhandled timer error in the worker.
  await closeProxyAgents();
  try { repos.close(); db.close(); } catch { /* already closed */ }
});

/** A pool plus the exits it is meant to have — the shape the API writes. */
const addPool = (name, urls, extra = {}) => {
  const pool = repos.proxyPools.create({ name, config: { strict: extra.strict } });
  if (urls?.length) repos.proxyPoolEntries.addMany(pool.id, urls);
  return repos.proxyPools.get(pool.id);
};

const urlsOf = (plan) => (plan?.candidates ?? []).map((c) => c.url);

describe("pool shape", () => {
  it("treats strict as opt-out and holds many exits", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    expect(poolStrict(p)).toBe(true); // default: fail rather than leak the real address
    expect(poolExits(repos, p).map((e) => e.url)).toEqual(["http://one.example:1111", "http://two.example:2222"]);
    const loose = addPool("loose", ["http://three.example:3333"], { strict: false });
    expect(poolStrict(loose)).toBe(false);
  });

  it("rejects a url-less pool as unusable", () => {
    const empty = repos.proxyPools.create({ name: "empty", config: {} });
    expect(poolUsable(repos, empty)).toBe(false);
    expect(poolExits(repos, empty)).toEqual([]);
  });

  it("skips disabled exits", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    repos.proxyPoolEntries.update(poolExits(repos, p)[0].id, { enabled: false });
    expect(poolExits(repos, repos.proxyPools.get(p.id)).map((e) => e.url)).toEqual(["http://two.example:2222"]);
  });

  it("skips a url that is already in the pool instead of failing", () => {
    const p = addPool("fleet", ["http://one.example:1111"]);
    const added = repos.proxyPoolEntries.addMany(p.id, ["http://one.example:1111", "http://two.example:2222"]);
    expect(added.map((e) => e.url)).toEqual(["http://two.example:2222"]);
  });

  it("forgets a verdict when the url it described is replaced", () => {
    const p = addPool("fleet", ["http://one.example:1111"]);
    const entry = poolExits(repos, p)[0];
    repos.proxyPoolEntries.recordTest(entry.id, { ok: true, egressIp: "203.0.113.7" });
    const updated = repos.proxyPoolEntries.update(entry.id, { url: "http://nine.example:9999" });
    expect(updated.egressIp).toBeNull();
    expect(updated.lastTestOk).toBeNull();
  });
});

describe("resolution precedence", () => {
  it("uses the key's own fleet before the provider's", () => {
    const providerPool = addPool("provider", ["http://provider.example:1111"]);
    const keyPool = addPool("key", ["http://key.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [providerPool.id], strategy: "none" } } });
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x", proxyPoolId: keyPool.id } });

    const plan = resolveNodeProxy(repos, repos.nodes.get(node.id), conn);
    expect(urlsOf(plan)).toEqual(["http://key.example:2222"]);
    expect(plan.source).toBe("key");
  });

  it("falls back to the provider setting when the key's pool is gone", () => {
    const providerPool = addPool("provider", ["http://provider.example:1111"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [providerPool.id], strategy: "none" } } });
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x", proxyPoolId: "deleted-pool-id" } });

    const plan = resolveNodeProxy(repos, repos.nodes.get(node.id), conn);
    expect(urlsOf(plan)).toEqual(["http://provider.example:1111"]);
    expect(plan.source).toBe("provider");
  });

  it("resolves nothing when neither is configured", () => {
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x" } });
    expect(resolveNodeProxy(repos, repos.nodes.get(node.id), conn)).toBeNull();
  });

  it("ignores a disabled pool", () => {
    const p = addPool("off", ["http://proxy.example:8080"]);
    repos.proxyPools.update(p.id, { enabled: false });
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "none" } } });
    expect(resolveNodeProxy(repos, repos.nodes.get(node.id), null)).toBeNull();
  });

  it("fails a bound-but-empty pool instead of going direct", () => {
    // The one case that must NOT fall through: the user bound a pool and has not filled it
    // yet. A silent direct request is exactly what the binding exists to prevent.
    const empty = repos.proxyPools.create({ name: "not-yet", config: {} });
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [empty.id], strategy: "none" } } });
    const plan = resolveNodeProxy(repos, repos.nodes.get(node.id), null);
    expect(plan.candidates).toEqual([]);
    expect(plan.directAllowed).toBe(false);
    expect(plan.reason).toContain("no exits");
  });

  it("allows a direct fallback only when no bound pool is strict", () => {
    const loose = addPool("loose", ["http://one.example:1111"], { strict: false });
    const strict = addPool("strict", ["http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [loose.id], strategy: "none" } } });
    expect(resolveNodeProxy(repos, repos.nodes.get(node.id), null).directAllowed).toBe(true);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [loose.id, strict.id], strategy: "none" } } });
    expect(resolveNodeProxy(repos, repos.nodes.get(node.id), null).directAllowed).toBe(false);
  });
});

describe("rotation across exits", () => {
  it("round-robins the exits of one fleet, per provider", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222", "http://three.example:3333"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "round-robin" } } });
    const n = repos.nodes.get(node.id);
    const seen = [0, 1, 2, 3].map(() => urlsOf(resolveNodeProxy(repos, n, null))[0]);
    expect(seen).toEqual([
      "http://one.example:1111", "http://two.example:2222", "http://three.example:3333", "http://one.example:1111",
    ]);
  });

  it("rotates across every fleet's exits in one cycle", () => {
    const p1 = addPool("p1", ["http://one.example:1111"]);
    const p2 = addPool("p2", ["http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p1.id, p2.id], strategy: "round-robin" } } });
    const n = repos.nodes.get(node.id);
    expect([0, 1, 2, 3].map(() => urlsOf(resolveNodeProxy(repos, n, null))[0]))
      .toEqual(["http://one.example:1111", "http://two.example:2222", "http://one.example:1111", "http://two.example:2222"]);
  });

  it("uses every enabled pool when none is picked explicitly", () => {
    const p1 = addPool("p1", ["http://one.example:1111"]);
    const p2 = addPool("p2", ["http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { strategy: "round-robin" } } });
    const n = repos.nodes.get(node.id);
    const seen = new Set([0, 1, 2, 3].map(() => urlsOf(resolveNodeProxy(repos, n, null))[0]));
    expect(seen).toEqual(new Set(["http://one.example:1111", "http://two.example:2222"]));
  });

  it("keeps a fixed fleet in order for strategy none", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "none" } } });
    const n = repos.nodes.get(node.id);
    expect([0, 1, 2].map(() => urlsOf(resolveNodeProxy(repos, n, null))[0]))
      .toEqual(["http://one.example:1111", "http://one.example:1111", "http://one.example:1111"]);
  });

  it("random stays inside the fleet", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "random" } } });
    const n = repos.nodes.get(node.id);
    const allowed = new Set(["http://one.example:1111", "http://two.example:2222"]);
    for (let i = 0; i < 20; i++) expect(allowed.has(urlsOf(resolveNodeProxy(repos, n, null))[0])).toBe(true);
  });

  it("skips a cooling exit and reports how many it skipped", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "round-robin" } } });
    const n = repos.nodes.get(node.id);
    const first = poolExits(repos, p)[0];
    recordExitFailure(repos, { entryId: first.id, nodeId: n.id, failure: { kind: "connect", detail: "refused" } });

    const plan = resolveNodeProxy(repos, n, null);
    expect(urlsOf(plan)).toEqual(["http://two.example:2222"]);
    expect(plan.skipped).toBe(1);
  });

  it("stops rather than probing when every exit is cooling", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "round-robin" } } });
    const n = repos.nodes.get(node.id);
    for (const e of poolExits(repos, p)) recordExitFailure(repos, { entryId: e.id, nodeId: n.id, failure: { kind: "connect", detail: "refused" } });

    const plan = resolveNodeProxy(repos, n, null);
    expect(plan.candidates).toEqual([]);
    expect(plan.retryAfterMs).toBeGreaterThan(0);
    expect(plan.reason).toContain("cooling");
    // A probe asks about the address itself, and does not touch traffic health.
    const probe = resolveNodeProxy(repos, n, null, { includeCooling: true, recordHealth: false });
    expect(urlsOf(probe)).toHaveLength(2);
  });
});

describe("exit health", () => {
  const entryOf = (pool) => poolExits(repos, pool)[0];

  it("cools an exit and doubles the window on the next failure", () => {
    const p = addPool("fleet", ["http://one.example:1111"]);
    const e = entryOf(p);
    const first = recordExitFailure(repos, { entryId: e.id, nodeId: node.id, failure: { kind: "connect", detail: "refused" } });
    expect(first.cooldownMs).toBe(60_000);
    expect(isExitAvailable(entryHealth(repos, e.id, node.id))).toBe(false);
    // still cooling when the next failure arrives → the streak doubles the window
    const second = recordExitFailure(repos, { entryId: e.id, nodeId: node.id, failure: { kind: "connect", detail: "refused" } });
    expect(second.cooldownMs).toBe(120_000);
  });

  it("honours Retry-After over its own default", () => {
    const p = addPool("fleet", ["http://one.example:1111"]);
    const e = entryOf(p);
    const { cooldownMs } = recordExitFailure(repos, {
      entryId: e.id, nodeId: node.id,
      failure: { kind: "rate_limit", detail: "429", retryAfterMs: 900_000 },
    });
    expect(cooldownMs).toBe(900_000);
  });

  it("takes the base from settings when the limits are not per-minute", () => {
    // A provider that meters per hour wants an hour-shaped cooldown; doubling the default
    // to get there would park the exit for the whole fleet's worth of mistakes.
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    const e = entryOf(p);
    const { cooldownMs } = recordExitFailure(repos, {
      entryId: e.id, nodeId: node.id, settings: { proxyCooldownMs: 900_000 },
      failure: { kind: "rate_limit", detail: "429" },
    });
    expect(cooldownMs).toBe(900_000);
    // A nonsense setting falls back to the default base — on a FRESH exit, because a
    // repeat failure on the same one is doubling's job, not the fallback's.
    const fresh = poolExits(repos, p)[1];
    const bad = recordExitFailure(repos, {
      entryId: fresh.id, nodeId: node.id, settings: { proxyCooldownMs: 0 },
      failure: { kind: "rate_limit", detail: "429" },
    });
    expect(bad.cooldownMs).toBe(60_000);
  });
  it("clears the cooldown on success, and the streak with it", () => {
    const p = addPool("fleet", ["http://one.example:1111"]);
    const e = entryOf(p);
    recordExitFailure(repos, { entryId: e.id, nodeId: node.id, failure: { kind: "connect", detail: "refused" } });
    recordExitSuccess(repos, e.id, node.id);
    const state = entryHealth(repos, e.id, node.id);
    expect(isExitAvailable(state)).toBe(true);
    expect(state.cooldownStreak).toBe(0);
    // and the next failure starts from the base again rather than from the old streak
    expect(recordExitFailure(repos, { entryId: e.id, nodeId: node.id, failure: { kind: "connect", detail: "x" } }).cooldownMs).toBe(60_000);
  });

  it("scopes health per provider, not per exit", () => {
    const other = repos.nodes.create({ name: "B", prefix: "b", apiType: "openai", baseUrl: "http://127.0.0.1:45999/v1" });
    const p = addPool("fleet", ["http://one.example:1111"]);
    const e = entryOf(p);
    recordExitFailure(repos, { entryId: e.id, nodeId: node.id, failure: { kind: "connect", detail: "refused" } });
    expect(isExitAvailable(entryHealth(repos, e.id, node.id))).toBe(false);
    expect(isExitAvailable(entryHealth(repos, e.id, other.id))).toBe(true);
  });

  it("puts a whole fleet back in rotation on request", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    for (const e of poolExits(repos, p)) recordExitFailure(repos, { entryId: e.id, nodeId: node.id, failure: { kind: "connect", detail: "refused" } });
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [p.id], strategy: "none" } } });
    // cooling, so a request would have nothing to use
    expect(resolveNodeProxy(repos, repos.nodes.get(node.id), null).candidates).toHaveLength(0);
    expect(resetPoolHealth(repos, p.id)).toBe(2);
    expect(urlsOf(resolveNodeProxy(repos, repos.nodes.get(node.id), null))).toHaveLength(2);
  });

  it("drops the health of an exit that no longer exists", () => {
    const p = addPool("fleet", ["http://one.example:1111"]);
    const e = entryOf(p);
    recordExitFailure(repos, { entryId: e.id, nodeId: node.id, failure: { kind: "connect", detail: "refused" } });
    expect(repos.breakers.get(`proxy:${e.id}:${node.id}`)).toBeTruthy();
    repos.proxyPoolEntries.delete(e.id);
    expect(forgetExitHealth(repos, [e.id])).toBe(1);
    expect(repos.breakers.get(`proxy:${e.id}:${node.id}`)).toBeFalsy();
  });
});

describe("whose fault is it", () => {
  it("attributes only address-level signals to the exit", () => {
    expect(classifyProxyFailure({ kind: "connect" })).toBe("exit");
    expect(classifyProxyFailure({ status: 407 })).toBe("exit");
    expect(classifyProxyFailure({ status: 429, message: "rate limit exceeded for this ip" })).toBe("exit");
    // the provider-wide exceptions: no address can fix these
    expect(classifyProxyFailure({ status: 429, message: "upstream capacity exceeded, try again later" })).toBe("provider");
    expect(classifyProxyFailure({ status: 429, message: "all users are rate limited" })).toBe("provider");
    expect(classifyProxyFailure({ status: 503, message: "overloaded" })).toBe("provider");
    expect(classifyProxyFailure({ status: 401, message: "bad key" })).toBe("provider");
  });
});

describe("merge", () => {
  it("moves the exits and rewrites every binding", () => {
    const target = addPool("target", ["http://one.example:1111"]);
    const source = addPool("source", ["http://two.example:2222", "http://one.example:1111"]);
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x", proxyPoolId: source.id } });
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [source.id], strategy: "round-robin" } } });

    const merged = repos.proxyPools.merge(target.id, [source.id]);
    expect(merged.name).toBe("target");
    // the duplicate url stays a single row, keeping the target's row (and its health)
    expect(poolExits(repos, merged).map((e) => e.url)).toEqual(["http://one.example:1111", "http://two.example:2222"]);
    expect(repos.proxyPools.get(source.id)).toBeNull();
    expect(repos.connections.get(conn.id).credentials.proxyPoolId).toBe(target.id);
    expect(repos.nodes.get(node.id).data.proxy.poolIds).toEqual([target.id]);
    // and the surviving binding resolves to both exits
    expect(urlsOf(resolveNodeProxy(repos, repos.nodes.get(node.id), null))).toHaveLength(2);
  });

  it("collapses a node bound to two pools that become one", () => {
    const a = addPool("a", ["http://one.example:1111"]);
    const b = addPool("b", ["http://two.example:2222"]);
    repos.nodes.update(node.id, { data: { proxy: { poolIds: [a.id, b.id], strategy: "round-robin" } } });
    repos.proxyPools.merge(a.id, [b.id]);
    // not [a, a] — that would read as rotation between a fleet and itself
    expect(repos.nodes.get(node.id).data.proxy.poolIds).toEqual([a.id]);
  });
});

describe("deleting a pool", () => {
  it("takes its exits with it", () => {
    const p = addPool("fleet", ["http://one.example:1111", "http://two.example:2222"]);
    const ids = poolExits(repos, p).map((e) => e.id);
    repos.proxyPools.delete(p.id);
    expect(repos.proxyPoolEntries.listByPool(p.id)).toEqual([]);
    expect(repos.proxyPoolEntries.get(ids[0])).toBeNull();
    expect(forgetExitHealth(repos, ids)).toBe(0); // nothing left to forget
  });
});

describe("migrations", () => {
  const buildLegacy = async (version, rows) => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `proxy-legacy-${version}-`));
    const legacy = new DatabaseSync(path.join(dir, "routy.db"));
    legacy.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    for (const m of MIGRATIONS.filter((x) => x.version <= version)) legacy.exec(m.up);
    legacy.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(version));
    const now = new Date().toISOString();
    for (const row of rows) {
      legacy.prepare(`INSERT INTO proxy_pools (id, name, kind, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.name, "static", JSON.stringify(row.config), 1, now, now);
    }
    legacy.close();
    return dir;
  };

  it("splits a v3 multi-url pool into pools, and gives each one an exit", async () => {
    // v4 split the pool; v5 has to hand each of those pools the URL it was split around, or
    // every binding resolves to nothing.
    const dir = await buildLegacy(3, [{ id: "pool-legacy", name: "old", config: { urls: ["http://a.example:1", "http://b.example:2"] } }]);
    const reopened = openDatabase(dir);
    const pools = reopened.prepare(`SELECT id, name, config FROM proxy_pools ORDER BY name`).all();
    expect(pools).toHaveLength(2);
    expect(pools.find((p) => p.id === "pool-legacy")).toBeTruthy();
    const entries = reopened.prepare(`SELECT pool_id, url FROM proxy_pool_entries ORDER BY url`).all();
    expect(entries.map((e) => e.url)).toEqual(["http://a.example:1", "http://b.example:2"]);
    expect(new Set(entries.map((e) => e.pool_id))).toEqual(new Set(pools.map((p) => p.id)));
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("gives a v4 one-url pool its exit", async () => {
    const dir = await buildLegacy(4, [{ id: "pool-v4", name: "solo", config: { url: "http://user:pass@proxy.example:8080", strict: true } }]);
    const reopened = openDatabase(dir);
    const entries = reopened.prepare(`SELECT pool_id, url, enabled FROM proxy_pool_entries`).all();
    expect(entries).toEqual([{ pool_id: "pool-v4", url: "http://user:pass@proxy.example:8080", enabled: 1 }]);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("exit identity", () => {
  it("treats the same endpoint as one exit, whatever the path", () => {
    // A pasted list that reaches the same host twice is one exit; counting it twice would
    // double the fleet on paper while the upstream still saw one address.
    expect(proxyIdentity("http://h.example:8080")).toBe("http://h.example:8080");
    expect(proxyIdentity("http://h.example:8080/some/path")).toBe("http://h.example:8080");
    expect(proxyIdentity("http://h.example:8080/")).toBe("http://h.example:8080");
    // credentials DO distinguish: many providers hand a different address per user:pass
    expect(proxyIdentity("http://u:p@h.example:8080")).not.toBe(proxyIdentity("http://h.example:8080"));
    // so do scheme and port
    expect(proxyIdentity("socks5://h.example:1080")).not.toBe(proxyIdentity("http://h.example:1080"));
    // and an unparseable value compares as written rather than guessing what it meant
    expect(proxyIdentity("not a url")).toBe("not a url");
    expect(proxyIdentity("")).toBe("");
  });
});

describe("egress address", () => {
  it("reads the address out of the usual echo replies", () => {
    expect(parseEgressIp('{"ip":"203.0.113.7"}')).toBe("203.0.113.7");
    expect(parseEgressIp("203.0.113.7\n")).toBe("203.0.113.7");
    expect(parseEgressIp('{"origin":"198.51.100.4, 198.51.100.5"}')).toBe("198.51.100.4");
    expect(parseEgressIp("2001:db8::1")).toBe("2001:db8::1");
    expect(parseEgressIp("<html>hello</html>")).toBeNull();
    expect(parseEgressIp("")).toBeNull();
  });
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
      const s = http.createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ip":"203.0.113.7"}'));
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
  });
  afterEach(async () => {
    // `close()` waits for idle connections; the ProxyAgent's keep-alive socket is not idle
    // from the server's point of view, so without this the hook blocks until timeout.
    for (const s of [proxyServer, origin]) {
      if (!s) continue;
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
    proxyServer = null;
    origin = null;
  });

  it("reports a working authenticated proxy as reachable", async () => {
    const started = await startProxy({ requireAuth: "buffrelay1:buffrelaypass" });
    proxyServer = started.server;
    const url = `http://buffrelay1:buffrelaypass@127.0.0.1:${started.port}`;
    const result = await testProxyUrl(url, { testUrl: `http://127.0.0.1:${origin.address().port}/` });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    // the address the provider would see, read from the reply — not assumed
    expect(result.egressIp).toBe("203.0.113.7");
  }, 20_000);

  it("surfaces the real cause when the proxy refuses", async () => {
    const started = await startProxy({ refuse: true });
    proxyServer = started.server;
    const result = await testProxyUrl(`http://127.0.0.1:${started.port}`, { testUrl: `http://127.0.0.1:${origin.address().port}/` });
    expect(result.ok).toBe(false);
    expect(String(result.error)).not.toBe(""); // a reason, not a bare failure
  }, 20_000);

  it("rejects credentials the proxy does not accept", async () => {
    const started = await startProxy({ requireAuth: "right:creds" });
    proxyServer = started.server;
    const result = await testProxyUrl(`http://wrong:creds@127.0.0.1:${started.port}`, { testUrl: `http://127.0.0.1:${origin.address().port}/` });
    expect(result.ok).toBe(false);
  }, 20_000);
});
