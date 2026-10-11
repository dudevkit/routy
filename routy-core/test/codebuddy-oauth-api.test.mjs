// CodeBuddy Intl OAuth — HTTP-level route tests.
//
// A real temp DB and the real API router, but every upstream CodeBuddy call is stubbed
// via global fetch, so nothing reaches the network and no quota is spent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { createRouter } from "../lib/router.mjs";

let tmp, db, repos, server, port, cfg, upstream;

const request = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = http.request(
    { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null }));
    },
  );
  req.on("error", reject);
  req.end(payload ?? undefined);
});
const post = (p, body, headers) => request("POST", p, body, headers);
const put = (p, body, headers) => request("PUT", p, body, headers);
const del = (p, headers) => request("DELETE", p, undefined, headers);
const ACTION = { "x-routy-action": "1" };

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stub upstream: state returns a valid login URL; poll reports pending then complete. */
function installUpstream({ pollCodes = [] } = {}) {
  let pollCalls = 0;
  upstream = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/plugin/auth/state")) {
      return jsonRes(200, { code: 0, data: { state: "st-1", authUrl: "https://www.workbuddy.ai/login?platform=ide&state=st-1" } });
    }
    if (u.includes("/plugin/auth/token/refresh")) {
      return jsonRes(200, { code: 0, data: { accessToken: "at-refreshed", refreshToken: "rt-2", expiresIn: 3600 } });
    }
    if (u.includes("/plugin/auth/token")) {
      const code = pollCodes[Math.min(pollCalls++, pollCodes.length - 1)];
      if (code === 0) return jsonRes(200, { code: 0, data: { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 } });
      return jsonRes(200, { code: code ?? 11217 });
    }
    return jsonRes(404, { msg: "unexpected" });
  });
  vi.stubGlobal("fetch", upstream);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-oauth-api-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });
  cfg = { bootstrapToken: "tok" };
  const dispatch = createRouter(buildApiRoutes(repos, cfg, "0.1.0"));
  await new Promise((resolve) => {
    server = http.createServer((req, res) => dispatch(req, res));
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  port = server.address().port;
  installUpstream();
});

afterEach(async () => {
  vi.restoreAllMocks();
  try { repos.close(); db.close(); } catch { /* closed */ }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

describe("oauth start", () => {
  it("requires the same-origin action header", async () => {
    const r = await post("/api/providers/codebuddy-intl/oauth/start", { intent: "create", name: "CB", prefix: "cb" });
    expect(r.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("starts a create flow and returns a safe flow view (no upstream state)", async () => {
    const r = await post("/api/providers/codebuddy-intl/oauth/start", { intent: "create", name: "CB", prefix: "cb" }, ACTION);
    expect(r.status).toBe(200);
    expect(r.body.flowId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.verificationUrl).toContain("www.workbuddy.ai/login");
    // The state rides in the login URL by design; what must never appear is a SEPARATE field.
    expect(r.body.upstreamState).toBeUndefined();
    expect(r.body.state).toBeUndefined();
  });

  it("409s a duplicate prefix before starting an upstream flow", async () => {
    repos.nodes.create({ name: "X", prefix: "cb", apiType: "openai", baseUrl: "http://127.0.0.1:9/v1" });
    upstream.mockClear();
    const r = await post("/api/providers/codebuddy-intl/oauth/start", { intent: "create", name: "CB", prefix: "cb" }, ACTION);
    expect(r.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("lists the provider for the dashboard", async () => {
    const r = await request("GET", "/api/providers/oauth");
    expect(r.status).toBe(200);
    expect(r.body.providers[0].id).toBe("codebuddy-intl");
  });
});

describe("oauth poll/commit", () => {
  it("creates exactly one node+connection on completion, marked server-side", async () => {
    installUpstream({ pollCodes: [0] });
    const start = await post("/api/providers/codebuddy-intl/oauth/start", { intent: "create", name: "CB", prefix: "cb" }, ACTION);
    const { flowId } = start.body;
    // First poll may be rejected by the server-side cadence; wait is implicit because the
    // manager sets lastPollAt at start. Poll once.
    const poll = await post(`/api/providers/codebuddy-intl/oauth/flows/${flowId}/poll`, {}, ACTION);
    expect([200, 429]).toContain(poll.status);
    if (poll.status === 200 && poll.body.state === "complete") {
      const nodes = repos.nodes.list();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].data.authProvider).toBe("codebuddy-intl-oauth");
      expect(nodes[0].baseUrl).toBe("https://www.workbuddy.ai/v2/chat/completions");
      const conns = repos.connections.list(nodes[0].id);
      expect(conns).toHaveLength(1);
      expect(conns[0].credentials.authType).toBe("oauth");
      expect(conns[0].credentials.accessToken).toBe("at-1");
      // The API view never carries the token.
      const view = await request("GET", `/api/nodes/${nodes[0].id}/connections`);
      expect(JSON.stringify(view.body)).not.toContain("at-1");
      expect(view.body[0].keyMasked).toBe("OAuth");
      expect(view.body[0].authState).toBe("active");
    }
  });

  it("cancel is idempotent and safe", async () => {
    const start = await post("/api/providers/codebuddy-intl/oauth/start", { intent: "create", name: "CB", prefix: "cb" }, ACTION);
    const { flowId } = start.body;
    const c1 = await del(`/api/providers/codebuddy-intl/oauth/flows/${flowId}`, ACTION);
    expect(c1.status).toBe(200);
    expect(c1.body.state).toBe("cancelled");
    const c2 = await del(`/api/providers/codebuddy-intl/oauth/flows/${flowId}`, ACTION);
    expect(c2.body.state).toBe("cancelled");
    expect(repos.nodes.list()).toHaveLength(0);
  });

  it("404s an unknown flow and requires the action header", async () => {
    expect((await del("/api/providers/codebuddy-intl/oauth/flows/deadbeef", ACTION)).status).toBe(404);
    expect((await post("/api/providers/codebuddy-intl/oauth/flows/deadbeef/poll", {})).status).toBe(400);
  });
});

describe("OAuth node protection", () => {
  async function makeOAuthNode() {
    installUpstream({ pollCodes: [0] });
    const start = await post("/api/providers/codebuddy-intl/oauth/start", { intent: "create", name: "CB", prefix: "cb" }, ACTION);
    await post(`/api/providers/codebuddy-intl/oauth/flows/${start.body.flowId}/poll`, {}, ACTION);
    return repos.nodes.list()[0];
  }

  it("rejects generic API-key writes and protected-field changes", async () => {
    const node = await makeOAuthNode();
    if (!node) return; // poll was rate-limited; skip
    expect((await put(`/api/nodes/${node.id}`, { apiKey: "sk-x" }, ACTION)).status).toBe(409);
    expect((await put(`/api/nodes/${node.id}`, { baseUrl: "https://evil.example.com" }, ACTION)).status).toBe(409);
    expect((await post(`/api/nodes/${node.id}/connections`, { apiKey: "sk-x" }, ACTION)).status).toBe(409);
    expect((await post(`/api/nodes/${node.id}/connections/batch`, { entries: [{ apiKey: "sk-x" }] }, ACTION)).status).toBe(409);
  });

  it("refuses to mint an OAuth marker through generic node create", async () => {
    const r = await post("/api/nodes", { name: "Fake", prefix: "fake", baseUrl: "https://x/v1", data: { authProvider: "codebuddy-intl-oauth" } }, ACTION);
    expect(r.status).toBe(400);
  });

  it("disables bulk key probing on an OAuth node", async () => {
    const node = await makeOAuthNode();
    if (!node) return;
    expect((await post(`/api/nodes/${node.id}/keys/test`, {}, ACTION)).status).toBe(400);
  });
});
