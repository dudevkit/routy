// P2.2 management API integration tests — HTTP-level, temp db, hermetic stub.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes, mgmtAuthorized } from "../http/api.mjs";
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

  it("batch key import creates N connections with staggered priority", async () => {
    const node = await post("/api/nodes", { name: "Batch", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "sk-first000000000000", prefix: "batch" });
    const r = await post(`/api/nodes/${node.body.id}/connections/batch`, { keys: ["sk-aaa111222333444555", "sk-bbb111222333444555", "", "sk-ccc111222333444555"] });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(3); // empty string filtered out
    expect(r.body.connections[0].keyMasked).toContain("sk-");
    expect(r.body.connections[0].keyMasked).not.toContain("aaa111");
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

  it("node test uses the stored key and persists modelCount", async () => {
    const created = await post("/api/nodes", { name: "Up", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "k-abc-12345678", prefix: "u1" });
    const r = await post(`/api/nodes/${created.body.id}/test`, {});
    expect(r.body.ok).toBe(true);
    expect(stubState.requests[0]).toBe("Bearer k-abc-12345678");
    const view = (await get("/api/nodes")).body[0];
    expect(view.modelCount).toBe(3);
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

  it("issues an api key once and verifies it via repos", async () => {
    const r = await post("/api/keys", { name: "test" });
    expect(r.status).toBe(201);
    expect(repos.apiKeys.verify(r.body.key)?.id).toBe(r.body.id);
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

  it("guards /api for non-loopback peers via token", () => {
    const fakeReq = (addr, auth) => ({ socket: { remoteAddress: addr }, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    expect(mgmtAuthorized(fakeReq("127.0.0.1"), cfg)).toBe(true);
    expect(mgmtAuthorized(fakeReq("10.1.2.3"), cfg)).toBe(false);
    expect(mgmtAuthorized(fakeReq("10.1.2.3", "tok-123"), cfg)).toBe(true);
    expect(mgmtAuthorized(fakeReq("10.1.2.3", "wrong"), cfg)).toBe(false);
  });
});
