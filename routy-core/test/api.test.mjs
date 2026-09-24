// P2.2 management API integration tests — HTTP-level, temp db, hermetic stub.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes, mgmtAuthorized } from "../http/api.mjs";
import { loadOrCreateManagementToken } from "../lib/auth.mjs";
import { createRouter } from "../lib/router.mjs";

let tmp, db, repos, server, handlerPort, stubServer, stubPort, stubState, cfg;

const request = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = http.request(
    { host: "127.0.0.1", port: handlerPort, path: p, method, headers: { "content-type": "application/json", ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null }));
    },
  );
  req.on("error", reject);
  req.end(payload ?? undefined);
});
const get = (p) => request("GET", p);
const post = (p, body) => request("POST", p, body);
const put = (p, body) => request("PUT", p, body);
const del = (p) => request("DELETE", p);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-api-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });

  stubState = { requests: [] };
  await new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      stubState.requests.push(req.headers.authorization || null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }));
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });
  stubPort = stubServer.address().port;

  cfg = { bootstrapToken: "tok-123" };
  const dispatch = createRouter(buildApiRoutes(repos, cfg, "0.1.0"));
  await new Promise((resolve) => {
    server = http.createServer((req, res) => dispatch(req, res));
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  handlerPort = server.address().port;
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  server.closeAllConnections?.();
  stubServer.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await new Promise((r) => stubServer.close(r));
});

describe("management API", () => {
  it("creates a node with key (masked in view), lists, deletes", async () => {
    const created = await post("/api/nodes", { name: "Up A", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "sk-super-secret-key-99", prefix: "upa" });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("healthy");
    expect(created.body.keyMasked).toContain("…");
    expect(created.body.keyMasked).not.toContain("super-secret");
    const list = await get("/api/nodes");
    expect(list.body).toHaveLength(1);
    expect((await del(`/api/nodes/${created.body.id}`)).status).toBe(204);
    expect((await get("/api/nodes")).body).toHaveLength(0);
  });

  it("409s on duplicate prefix instead of leaking SQLite errors (R3-2)", async () => {
    const first = await post("/api/nodes", { name: "A", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "k", prefix: "dup" });
    expect(first.status).toBe(201);
    const second = await post("/api/nodes", { name: "B", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "k", prefix: "dup" });
    expect(second.status).toBe(409);
    expect(second.body.error.detail).toContain("already in use");
  });

  it("batch key import creates N connections with staggered priority and per-entry labels", async () => {
    const node = await post("/api/nodes", { name: "Batch", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "sk-first000000000000", prefix: "batch" });
    const r = await post(`/api/nodes/${node.body.id}/connections/batch`, {
      entries: [
        { name: "prod", apiKey: "sk-aaa111222333444555" },
        { apiKey: "sk-bbb111222333444555" },
        { name: "ignored", apiKey: "   " },
        { name: "backup", apiKey: "sk-ccc111222333444555" },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(3); // blank key filtered out
    expect(r.body.connections[0].keyMasked).toContain("sk-");
    expect(r.body.connections[0].keyMasked).not.toContain("aaa111");
    expect(r.body.connections.map((c) => c.name)).toEqual(["prod", "Batch key 2", "backup"]);
    const conns = (await get(`/api/nodes/${node.body.id}/connections`)).body;
    expect(conns).toHaveLength(4); // 1 initial + 3 batch
    expect(conns[1].priority).toBeLessThan(conns[2].priority); // staggered
  });
  it("probes an unsaved baseUrl via POST /api/nodes/test", async () => {
    const r = await post("/api/nodes/test", { baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.modelCount).toBe(3);
  });

  it("import uses the stored key and fills the model list", async () => {
    const created = await post("/api/nodes", { name: "Up", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "k-abc-12345678", prefix: "u1" });
    const r = await post(`/api/nodes/${created.body.id}/models/import`, {});
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(3);
    expect(stubState.requests[0]).toBe("Bearer k-abc-12345678");
    const view = (await get("/api/nodes")).body[0];
    expect(view.modelCount).toBe(3);
    expect(view.models).toEqual(["m1", "m2", "m3"]);
  });

  it("returns usage stats shape and failures", async () => {
    repos.usage.record({ nodeId: "n1", model: "m", status: "ok", promptTokens: 10, completionTokens: 5, ttftMs: 42 });
    repos.usage.record({ nodeId: "n1", model: "m", status: "error", errorCode: "upstream_error", promptTokens: 3, ttftMs: 9 });
    repos.usage.flush();
    const stats = await get("/api/usage/stats");
    expect(stats.body).toEqual({
      requestsToday: expect.any(Number),
      tokens7d: 18,
      costUsd7d: 0,
      costUsdToday: 0, // unmetered rows record no cost
      errorRatePct: 50,
      ttftP50Ms: expect.any(Number),
    });
    const fails = await get("/api/usage/failures");
    expect(fails.body).toHaveLength(1);
    expect(fails.body[0].errorCode).toBe("upstream_error");
    expect(fails.body[0].nodeName).toBe("n1"); // unregistered node → id fallback
  });

  it("gateway info carries endpoint + version", async () => {
    const g = await get("/api/gateway");
    expect(g.body.online).toBe(true);
    expect(g.body.version).toBe("0.1.0");
    expect(g.body.endpoint).toContain("/v1");
  });

  it("settings round-trips", async () => {
    const r = await put("/api/settings", { rtkEnabled: false, requireApiKey: true });
    expect(r.body.rtkEnabled).toBe(false);
    expect((await get("/api/settings")).body.requireApiKey).toBe(true);
  });

  it("issues an api key and verifies it via repos", async () => {
    const r = await post("/api/keys", { name: "test" });
    expect(r.status).toBe(201);
    expect(repos.apiKeys.verify(r.body.key)?.id).toBe(r.body.id);
    // no show-once warning: the key stays retrievable from the dashboard
    expect(r.body.warning).toBeUndefined();
    expect((await get("/api/keys")).body.find((k) => k.id === r.body.id).key).toBe(r.body.key);
  });

  it("resets breakers by scope", async () => {
    repos.breakers.record("node:x", { state: "open", openUntil: new Date(Date.now() + 60000).toISOString(), failureDelta: 3 });
    const r = await post("/api/breakers/node%3Ax/reset", {});
    expect(r.body.state).toBe("closed");
    expect(r.body.failures).toBe(0);
  });

  it("node reset clears the breaker failure count (not just the state)", async () => {
    const node = repos.nodes.create({ name: "R", prefix: "r", apiType: "openai", baseUrl: "http://127.0.0.1:1/v1" });
    repos.breakers.record(`node:${node.id}`, { state: "open", openUntil: new Date(Date.now() + 60000).toISOString(), failureDelta: 3 });
    const r = await post(`/api/nodes/${node.id}/reset`, {});
    expect(r.status).toBe(200);
    const b = repos.breakers.get(`node:${node.id}`);
    expect(b.state).toBe("closed");
    expect(b.failures).toBe(0);
    expect(b.openUntil).toBeNull();
  });

  it("streams logs: init snapshot then live lines", async () => {
    let captured = "";
    const req = http.get({ host: "127.0.0.1", port: handlerPort, path: "/api/logs/stream" }, (res) => {
      expect(res.headers["content-type"]).toContain("text/event-stream");
      res.on("data", (c) => (captured += c.toString()));
    });
    await new Promise((r) => setTimeout(r, 150));
    const { log } = await import("../lib/log.mjs");
    log.info("TEST", "live line arrives");
    await new Promise((r) => setTimeout(r, 250));
    req.destroy();
    expect(captured).toContain("event: init");
    expect(captured).toContain("event: line");
    expect(captured).toContain("live line arrives");
  });

  it("guards /api for non-loopback peers once the token is required", () => {
    const fakeReq = (addr, auth) => ({ socket: { remoteAddress: addr }, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    // loopback is always allowed, token or not — that is the dashboard on this machine
    expect(mgmtAuthorized(fakeReq("127.0.0.1"), cfg, true)).toBe(true);
    expect(mgmtAuthorized(fakeReq("127.0.0.1"), cfg, false)).toBe(true);
    // token off (the default): any peer is allowed, which is the whole point
    expect(mgmtAuthorized(fakeReq("10.1.2.3"), cfg, false)).toBe(true);
    // token on: a non-loopback peer must present it
    expect(mgmtAuthorized(fakeReq("10.1.2.3"), cfg, true)).toBe(false);
    expect(mgmtAuthorized(fakeReq("10.1.2.3", "tok-123"), cfg, true)).toBe(true);
    expect(mgmtAuthorized(fakeReq("10.1.2.3", "wrong"), cfg, true)).toBe(false);
  });

  it("tells the dashboard whether this peer needs the token", async () => {
    // The one /api path a peer reaches unauthenticated, so the shell can decide
    // between the gate and the app. It must never return the token itself.
    const r = await get("/api/auth");
    expect(r.status).toBe(200);
    expect(r.body.required).toBe(false); // the harness connects over loopback, always open
    expect(typeof r.body.unlockedNetwork).toBe("boolean");
  });
});

describe("gateway info", () => {
  it("reports the endpoint the request arrived on, not the bind address", async () => {
    // With a 0.0.0.0 bind this used to report 127.0.0.1: correct from the server,
    // useless from anywhere else — you would copy it into a client on your laptop
    // and it would point at the laptop. The Host header is the address that worked.
    const r = await request("GET", "/api/gateway", undefined, { host: "192.168.1.230:8010" });
    expect(r.body.endpoint).toBe("http://192.168.1.230:8010/v1");
  });

  it("masks the real client key rather than inventing one from its id", async () => {
    const created = await post("/api/keys", { name: "masked" });
    const r = await get("/api/gateway");
    const mask = r.body.keyMasked;
    // a real mask of the real key: same first/last characters, no fabricated prefix
    expect(mask.startsWith(created.body.key.slice(0, 6))).toBe(true);
    expect(mask.endsWith(created.body.key.slice(-4))).toBe(true);
    expect(mask).not.toContain(created.body.id.slice(0, 4));
    expect(mask.startsWith("re_")).toBe(false);
  });
});

describe("management token", () => {
  it("is created once and reused, so a dashboard stays logged in", () => {
    // It used to be regenerated every boot. That was fine while /api was loopback
    // only, but the gateway now listens on the network, and a token that changes on
    // every restart would log the dashboard out every time the service bounced.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "routy-tok-"));
    const first = loadOrCreateManagementToken(home);
    expect(first.created).toBe(true);

    const second = loadOrCreateManagementToken(home);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("replaces a truncated token file instead of accepting it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "routy-tok-"));
    fs.writeFileSync(path.join(home, "mgmt-token"), "short\n");
    const result = loadOrCreateManagementToken(home);
    expect(result.created).toBe(true);
    expect(result.token.length).toBeGreaterThanOrEqual(32);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
