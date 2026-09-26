// Proxy failover through the real executor: a fleet where some exits are dead, some are
// rate-limited, and one works. Everything here is a real HTTP server — real proxies that
// rewrite the target to a chosen upstream, so "this exit was metered" and "that exit
// answered" are observable facts rather than stubbed return values.
//
// The boundary these tests exist to pin: a failure of the ADDRESS rotates the request, a
// failure of the PROVIDER does not (rotating over one upstream's 5xx would burn the fleet
// and misattribute the fault). Where a test distinguishes the two, that is what it asserts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { closeProxyAgents, entryHealth, entryScope, forgetExitHealth, isExitAvailable, poolExits, resetProxyRotation, resolveNodeProxy } from "../core/proxy.mjs";
import { DefaultExecutor } from "../core/executors/default.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { connectionState } from "../core/key-health.mjs";

let tmp, db, repos, node;
const servers = [];

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** An upstream that answers with a fixed status/body, and remembers what it received. */
async function startUpstream({ status = 200, body = '{"choices":[]}', headers = {} } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(body);
    });
  });
  const port = await listen(server);
  servers.push(server);
  return { server, port, hits };
}

/**
 * A forward proxy that sends everything to one chosen upstream. Real proxies route by the
 * request line; these route by construction, which is how each exit gets its own upstream
 * behaviour while the node keeps a single baseUrl.
 */
async function startProxy({ toPort, requireAuth = null } = {}) {
  const expected = requireAuth ? "Basic " + Buffer.from(requireAuth).toString("base64") : null;
  const server = http.createServer((req, res) => {
    if (expected && req.headers["proxy-authorization"] !== expected) return res.writeHead(407).end();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let pathname = req.url;
      try {
        const parsed = new URL(req.url);
        pathname = parsed.pathname + parsed.search;
      } catch { /* already a path */ }
      const up = http.request(
        { host: "127.0.0.1", port: toPort, path: pathname, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${toPort}` } },
        (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); },
      );
      up.on("error", () => res.writeHead(502).end());
      up.end(Buffer.concat(chunks));
    });
  });
  const port = await listen(server);
  servers.push(server);
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/** A port nothing is listening on: connecting to it fails outright, like a dead exit. */
async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
}

beforeEach(() => {
  // In-memory: these tests are about resolution, rotation and failover, not about the
  // driver's file handling, and a disk database per test was enough I/O contention to
  // starve other workers in the full suite.
  db = new DatabaseSync(":memory:");
  migrate(db);
  repos = createRepos(db);
  resetProxyRotation();
});
afterEach(async () => {
  // Two things must be released before a test server will fire `close`: the ProxyAgents
  // (which hold keep-alive sockets to the proxies) and the servers' own connections (the
  // proxies hold keep-alive sockets to the upstreams). Await either one alone and the hook
  // stalls until the test timeout, which is what starved the worker.
  await closeProxyAgents();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  try { repos.close(); db.close(); } catch { /* already closed */ }
});
function bindFleet(entries, { strict, strategy = "none" } = {}) {
  // 45999, not the classic "unroutable" port 9: undici rejects a list of well-known bad
  // ports outright ("bad port") before the proxy is ever consulted, so a fixture port has
  // to be one it will actually dial.
  node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: "http://127.0.0.1:45999/v1" });
  const pool = repos.proxyPools.create({ name: "fleet", config: { strict } });
  repos.proxyPoolEntries.addMany(pool.id, entries);
  repos.nodes.update(node.id, { data: { proxy: { poolIds: [pool.id], strategy } } });
  return repos.proxyPools.get(pool.id);
}

/** Run one request through the real executor, with the plan the gateway would build. */
async function run({ model = "the-model" } = {}) {
  const fresh = repos.nodes.get(node.id);
  const plan = resolveNodeProxy(repos, fresh, null);
  const executor = new DefaultExecutor(fresh, { id: "conn-1", credentials: { apiKey: "sk-test" } }, { proxy: plan });
  return executor.execute({ model, body: { messages: [{ role: "user", content: "hi" }] }, stream: false, signal: null, log: null });
}

const healthOf = (pool, index) => {
  const entry = poolExits(repos, pool)[index];
  return entryHealth(repos, entry.id, node.id);
};

describe("failover across a fleet", () => {
  it("rotates past an exit that cannot be reached and records its cooldown", async () => {
    const good = await startUpstream();
    const goodProxy = await startProxy({ toPort: good.port });
    const pool = bindFleet([`http://127.0.0.1:${await closedPort()}`, goodProxy.url]);

    const result = await run();
    expect(result.ok).toBe(true);
    expect(good.hits).toHaveLength(1);
    // the dead exit is out of rotation, scoped to this provider
    expect(isExitAvailable(healthOf(pool, 0))).toBe(false);
    expect(healthOf(pool, 0).lastError).toContain("could not be reached");
    expect(isExitAvailable(healthOf(pool, 1))).toBe(true);
  }, 20_000);

  it("hands a rate-limited request to the next address", async () => {
    const limited = await startUpstream({ status: 429, body: '{"error":"rate limit exceeded for this address"}' });
    const ok = await startUpstream();
    const limitedProxy = await startProxy({ toPort: limited.port });
    const okProxy = await startProxy({ toPort: ok.port });
    const pool = bindFleet([limitedProxy.url, okProxy.url]);

    const result = await run();
    expect(result.ok).toBe(true);
    expect(limited.hits).toHaveLength(1);
    expect(ok.hits).toHaveLength(1);
    expect(isExitAvailable(healthOf(pool, 0))).toBe(false);
    expect(healthOf(pool, 0).lastError).toContain("rate limited");
  }, 20_000);

  it("rotates past an exit whose credentials the proxy refuses", async () => {
    const ok = await startUpstream();
    const okProxy = await startProxy({ toPort: ok.port });
    // right proxy, wrong password in the URL
    const refused = await startProxy({ toPort: ok.port, requireAuth: "right:creds" });
    const pool = bindFleet([`http://wrong:creds@127.0.0.1:${refused.port}`, okProxy.url]);

    const result = await run();
    expect(result.ok).toBe(true);
    expect(ok.hits).toHaveLength(1);
    expect(healthOf(pool, 0).lastError).toContain("407");
  }, 20_000);

  it("tries at most three exits when every answer is a rate limit", async () => {
    // The bet behind rotating on 429 is "the limit is per address". When it is per account
    // instead, that bet costs one request per exit — so it is capped, and this pins it.
    const limited = await startUpstream({ status: 429, body: "rate limit exceeded for this address" });
    const urls = [];
    for (let i = 0; i < 5; i++) urls.push((await startProxy({ toPort: limited.port })).url);
    bindFleet(urls);

    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("proxy_exhausted");
    expect(result.status).toBe(429);
    expect(limited.hits).toHaveLength(3); // not 5
  }, 20_000);

  it("does not rotate when the provider itself is rate limiting", async () => {
    const global = await startUpstream({ status: 429, body: "upstream capacity exceeded, try again later" });
    const ok = await startUpstream();
    const globalProxy = await startProxy({ toPort: global.port });
    const okProxy = await startProxy({ toPort: ok.port });
    const pool = bindFleet([globalProxy.url, okProxy.url]);

    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("rate_limited");
    expect(ok.hits).toHaveLength(0); // no point offering this to another address
    // and the address is NOT blamed for it
    expect(isExitAvailable(healthOf(pool, 0))).toBe(true);
    expect(healthOf(pool, 0).openUntil ?? null).toBeNull();
  }, 20_000);

  it("does not rotate on a 5xx from the provider", async () => {
    const broken = await startUpstream({ status: 500, body: "boom" });
    const ok = await startUpstream();
    const brokenProxy = await startProxy({ toPort: broken.port });
    const okProxy = await startProxy({ toPort: ok.port });
    const pool = bindFleet([brokenProxy.url, okProxy.url]);

    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("upstream_error");
    expect(ok.hits).toHaveLength(0); // a working proxy can carry a 5xx; the fleet is not at fault
    expect(isExitAvailable(healthOf(pool, 0))).toBe(true);
  }, 20_000);

  it("fails without a request when every exit is already cooling", async () => {
    const ok = await startUpstream();
    const okProxy = await startProxy({ toPort: ok.port });
    const pool = bindFleet([okProxy.url]);
    const entry = poolExits(repos, pool)[0];
    repos.breakers.record(entryScope(entry.id, node.id), {
      state: "cooldown", openUntil: new Date(Date.now() + 30_000).toISOString(), cooldownStreak: 1, lastError: "rate limited",
    });

    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("proxy_exhausted");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.message).toContain("cooling");
    expect(ok.hits).toHaveLength(0); // probing a cooling exit is how a fleet locks itself out
  }, 20_000);

  it("clears an expired cooldown once an exit answers again", async () => {
    const ok = await startUpstream();
    const okProxy = await startProxy({ toPort: ok.port });
    const pool = bindFleet([okProxy.url]);
    const entry = poolExits(repos, pool)[0];
    repos.breakers.record(entryScope(entry.id, node.id), {
      state: "cooldown", openUntil: new Date(Date.now() - 1_000).toISOString(), cooldownStreak: 2, lastError: "old",
    });

    const result = await run();
    expect(result.ok).toBe(true);
    const state = healthOf(pool, 0);
    expect(isExitAvailable(state)).toBe(true);
    expect(state.cooldownStreak).toBe(0);
    expect(state.openUntil).toBeNull();
  }, 20_000);
});

describe("when the fleet cannot serve at all", () => {
  it("fails with the pool named when strict, without leaking a direct request", async () => {
    const direct = await startUpstream();
    const pool = bindFleet([`http://127.0.0.1:${await closedPort()}`], { strict: true });
    node = repos.nodes.update(node.id, { baseUrl: `http://127.0.0.1:${direct.port}/v1` });

    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("proxy_failed");
    expect(result.message).toContain("fleet");
    expect(result.message).toContain("not retrying directly");
    expect(direct.hits).toHaveLength(0);
    expect(poolStrictOf(pool)).toBe(true);
  }, 20_000);

  it("falls back to a direct request when strict is off, and says so", async () => {
    const direct = await startUpstream();
    bindFleet([`http://127.0.0.1:${await closedPort()}`], { strict: false });
    node = repos.nodes.update(node.id, { baseUrl: `http://127.0.0.1:${direct.port}/v1` });

    const result = await run();
    expect(result.ok).toBe(true);
    expect(direct.hits).toHaveLength(1);
  }, 20_000);
});

/** `strict` lives on the pool's config; kept as a helper so the assertion reads as intent. */
function poolStrictOf(pool) {
  return repos.proxyPools.get(pool.id).config.strict !== false;
}

describe("probe path", () => {
  it("uses one exit and leaves traffic health alone", async () => {
    // A probe asks about ONE address; failover would hide which one answered, and the
    // cooldown it sits in is exactly what the user wants to see.
    const dead = `http://127.0.0.1:${await closedPort()}`;
    const pool = bindFleet([dead]);
    const entry = poolExits(repos, pool)[0];
    repos.breakers.record(entryScope(entry.id, node.id), {
      state: "cooldown", openUntil: new Date(Date.now() + 60_000).toISOString(), cooldownStreak: 1, lastError: "cooling",
    });

    const plan = resolveNodeProxy(repos, repos.nodes.get(node.id), null, { includeCooling: true, recordHealth: false });
    expect(plan.candidates).toHaveLength(1);
    plan.onFailed(plan.candidates[0], { kind: "connect", detail: "refused" });
    // still cooling for the same reason, not re-stamped by the probe
    const state = healthOf(pool, 0);
    expect(state.lastError).toBe("cooling");
    expect(state.cooldownStreak).toBe(1);
  }, 20_000);
});

describe("housekeeping", () => {
  it("keeps a deleted exit out of the breaker store", async () => {
    const pool = bindFleet([`http://127.0.0.1:${await closedPort()}`]);
    const entry = poolExits(repos, pool)[0];
    repos.breakers.record(entryScope(entry.id, node.id), { state: "cooldown", openUntil: new Date(Date.now() + 5_000).toISOString() });
    repos.proxyPoolEntries.delete(entry.id);
    expect(forgetExitHealth(repos, [entry.id])).toBe(1);
    expect(repos.breakers.all().filter((b) => b.scope.startsWith("proxy:"))).toHaveLength(0);
  }, 20_000);
});
