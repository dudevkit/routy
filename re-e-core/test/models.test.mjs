// P6 — per-provider models and keys.
//
// The invariants that matter: import merges (never deletes manual rows), vanished
// imports go stale rather than disappearing, probes are diagnostics (no usage, no
// budget, no breaker effect), and the model list does NOT gate routing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createRouter } from "../lib/router.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { listModels, resolveRoute } from "../core/routing.mjs";
import { probeModel, probeKey, mapLimit } from "../core/probe.mjs";
import { budgetState, resetBudget } from "../core/budget.mjs";

let tmp, db, repos, stubServer, stubPort, stubState, apiServer, apiPort;

/** Stub upstream: /models lists `listed`; chat/completions streams per `behavior`. */
function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url.includes("/models")) {
          if (stubState.listFails) { res.writeHead(401).end("bad key"); return; }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: stubState.listed.map((id) => ({ id })) }));
          return;
        }
        const parsed = JSON.parse(body || "{}");
        stubState.chatRequests.push({ model: parsed.model, auth: req.headers.authorization ?? null, maxTokens: parsed.max_tokens, stream: parsed.stream });
        const behavior = stubState.behavior;
        if (behavior === "error") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "model not found" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (behavior === "silent") return; // headers only — never a frame
        res.write(`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"pong"},"finish_reason":null}]}\n\n`);
        res.write(`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-models-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  resetBudget();
  stubState = { listed: ["m-alpha", "m-beta", "m-gamma"], behavior: "ok", chatRequests: [], listFails: false };
  stubPort = await startStub();
  const dispatch = createRouter(buildApiRoutes(repos, { bootstrapToken: "t" }, "0.1.0"));
  apiPort = await new Promise((resolve) => {
    apiServer = http.createServer((req, res) => dispatch(req, res));
    apiServer.listen(0, "127.0.0.1", () => resolve(apiServer.address().port));
  });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  apiServer.closeAllConnections?.();
  stubServer.closeAllConnections?.();
  await new Promise((r) => apiServer.close(r));
  await new Promise((r) => stubServer.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Drive the management API over real HTTP. */
function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: apiPort, path: p, method, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d ? (() => { try { return JSON.parse(d); } catch { return d; } })() : null }));
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

const mkNode = (prefix, data = {}) =>
  repos.nodes.create({ name: prefix, prefix, apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`, data });
const mkKey = (node, apiKey = "k-1") =>
  repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey } });

describe("node_models repo", () => {
  it("adds manual models and re-enables rather than duplicating", () => {
    const node = mkNode("a");
    const m = repos.nodeModels.create({ nodeId: node.id, model: "custom-1" });
    expect(m.source).toBe("manual");
    expect(m.enabled).toBe(true);

    repos.nodeModels.update(m.id, { enabled: false });
    expect(repos.nodeModels.list(node.id)).toHaveLength(1);
    expect(repos.nodeModels.list(node.id)[0].enabled).toBe(false);

    // re-adding the same id re-enables instead of creating a second row
    const again = repos.nodeModels.create({ nodeId: node.id, model: "custom-1" });
    expect(again.id).toBe(m.id);
    expect(again.enabled).toBe(true);
    expect(repos.nodeModels.list(node.id)).toHaveLength(1);
  });

  it("import merges: manual rows survive and vanished imports go stale, never deleted", () => {
    const node = mkNode("a");
    repos.nodeModels.create({ nodeId: node.id, model: "mine" });

    const first = repos.nodeModels.import(node.id, ["m-alpha", "m-beta"]);
    expect(first).toMatchObject({ imported: 2, kept: 1, stale: 0 });
    expect(repos.nodeModels.list(node.id).map((m) => m.model).sort()).toEqual(["m-alpha", "m-beta", "mine"]);

    // m-beta disappears upstream
    const second = repos.nodeModels.import(node.id, ["m-alpha"]);
    expect(second.stale).toBe(1);
    const rows = repos.nodeModels.list(node.id);
    expect(rows).toHaveLength(3); // nothing deleted
    expect(rows.find((m) => m.model === "m-beta").stale).toBe(true);
    expect(rows.find((m) => m.model === "mine").stale).toBe(false); // manual untouched

    // it comes back — stale clears
    repos.nodeModels.import(node.id, ["m-alpha", "m-beta"]);
    expect(repos.nodeModels.list(node.id).find((m) => m.model === "m-beta").stale).toBe(false);
  });

  it("discovery exposes only enabled, non-stale models", () => {
    const node = mkNode("a");
    repos.nodeModels.import(node.id, ["m-alpha", "m-beta"]);
    const beta = repos.nodeModels.byModel(node.id, "m-beta");
    repos.nodeModels.update(beta.id, { enabled: false });
    expect(repos.nodeModels.enabledModels(node.id)).toEqual(["m-alpha"]);
  });

  it("backfills a legacy data.models array exactly once", () => {
    const node = mkNode("legacy", { models: ["old-1", "old-2"] });
    expect(repos.nodeModels.backfill(node.id, node.data.models)).toBe(2);
    expect(repos.nodeModels.list(node.id).map((m) => m.model)).toEqual(["old-1", "old-2"]);
    expect(repos.nodeModels.list(node.id)[0].source).toBe("imported");
    // second call is a no-op
    expect(repos.nodeModels.backfill(node.id, node.data.models)).toBe(0);
    expect(repos.nodeModels.list(node.id)).toHaveLength(2);
  });

  it("cascades on node delete", () => {
    const node = mkNode("gone");
    repos.nodeModels.import(node.id, ["x"]);
    repos.nodes.delete(node.id);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM node_models WHERE node_id = ?`).get(node.id).c).toBe(0);
  });
});

describe("model list is discovery-only", () => {
  it("still routes a model that is not in the list", () => {
    const node = mkNode("p");
    mkKey(node);
    repos.nodeModels.create({ nodeId: node.id, model: "listed-only" });

    const route = resolveRoute(repos, "p/never-configured");
    expect(route).not.toBeNull();
    expect(route.kind).toBe("node");
    expect(route.model).toBe("never-configured");
  });

  it("exposes enabled models in /v1/models and a wildcard when the list is empty", () => {
    const a = mkNode("a");
    repos.nodeModels.import(a.id, ["m-alpha", "m-beta"]);
    const b = mkNode("b"); // no models at all

    const ids = listModels(repos).data.map((m) => m.id);
    expect(ids).toContain("a/m-alpha");
    expect(ids).toContain("a/m-beta");
    expect(ids).toContain("b/*"); // empty list stays discoverable
  });
});

describe("probes are diagnostics, not traffic", () => {
  it("a model probe really streams and records TTFT on the row", async () => {
    const node = mkNode("a");
    const conn = mkKey(node, "k-model");
    const row = repos.nodeModels.create({ nodeId: node.id, model: "m-alpha" });

    const r = await probeModel(node, row.model, conn);
    expect(r.ok).toBe(true);
    expect(r.ttftMs).toBeGreaterThanOrEqual(0);
    // the probe really went out with that key, tiny and streamed
    expect(stubState.chatRequests).toHaveLength(1);
    expect(stubState.chatRequests[0]).toMatchObject({ model: "m-alpha", auth: "Bearer k-model", maxTokens: 1, stream: true });
  });

  it("records a failing model probe on the row without touching usage, budget or breakers", async () => {
    const node = mkNode("a");
    mkKey(node);
    const row = repos.nodeModels.create({ nodeId: node.id, model: "missing" });
    stubState.behavior = "error";

    const r = await call("POST", `/api/nodes/${node.id}/models/${row.id}/test`, {});
    expect(r.status).toBe(200);
    expect(r.body.lastTestOk).toBe(false);
    expect(r.body.lastTestError).toContain("model not found");

    expect(repos.usage.query({ limit: 10 })).toHaveLength(0); // no usage event
    expect(budgetState(1).spent).toBe(0); // no spend
    expect(repos.breakers.get(`node:${node.id}`)).toBeNull(); // breaker untouched
  });

  it("per-key test blames only that key", async () => {
    const node = mkNode("a");
    const good = repos.connections.create({ nodeId: node.id, name: "good", credentials: { apiKey: "k-good" } });
    const bad = repos.connections.create({ nodeId: node.id, name: "bad", credentials: { apiKey: "k-bad" } });
    stubState.listFails = true; // every key fails here

    const r = await call("POST", `/api/connections/${bad.id}/test`, {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain("401");

    // only the tested key carries the failure
    expect(repos.connections.get(bad.id).lastTestOk).toBe(false);
    expect(repos.connections.get(good.id).lastTestOk).toBeNull();
    expect(repos.connections.get(good.id).lastError).toBeNull();
    expect(repos.breakers.get(`node:${node.id}`)).toBeNull();
    expect(repos.usage.query({ limit: 10 })).toHaveLength(0);
  });

  it("a per-key test result is visible through the connections list", async () => {
    // Regression: the list route mapped a fixed field set and dropped the probe
    // result, so the UI could never show a tested key.
    const node = mkNode("a");
    const conn = repos.connections.create({ nodeId: node.id, name: "visible", credentials: { apiKey: "k-v" } });

    const tested = await call("POST", `/api/connections/${conn.id}/test`, {});
    expect(tested.body.ok).toBe(true);

    const list = await call("GET", `/api/nodes/${node.id}/connections`);
    const row = list.body.find((c) => c.id === conn.id);
    expect(row.lastTestOk).toBe(true);
    expect(row.lastTestAt).toBeTruthy();
    expect(row.lastTestTtftMs).toBeGreaterThanOrEqual(0);
    expect(row.keyMasked).not.toContain("k-v"); // still masked
  });

  it("bulk key test reports every key with bounded concurrency", async () => {
    const node = mkNode("a");
    for (let i = 0; i < 9; i++) repos.connections.create({ nodeId: node.id, name: `k${i}`, credentials: { apiKey: `k-${i}` } });
    repos.connections.create({ nodeId: node.id, name: "off", credentials: { apiKey: "k-off" }, status: "disabled" });

    const r = await call("POST", `/api/nodes/${node.id}/keys/test`, {});
    expect(r.status).toBe(200);
    expect(r.body.tested).toBe(9); // the disabled key is skipped
    expect(r.body.ok).toBe(9);
    expect(r.body.results.map((x) => x.name).sort()).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"]);
  });

  it("mapLimit keeps input order and never exceeds the limit", async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("a silent upstream fails the model probe instead of hanging", async () => {
    const node = mkNode("a");
    mkKey(node);
    const row = repos.nodeModels.create({ nodeId: node.id, model: "quiet" });
    stubState.behavior = "silent";

    const r = await probeModel(node, row.model, repos.connections.list(node.id)[0], { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout|empty stream/);
  });
});

describe("bulk model actions", () => {
  it("hides, shows and deletes a selection, scoped to the node", async () => {
    const node = mkNode("p");
    const other = mkNode("q");
    repos.nodeModels.import(node.id, ["m-alpha", "m-beta", "m-gamma"]);
    const foreign = repos.nodeModels.create({ nodeId: other.id, model: "not-yours" });
    const ids = repos.nodeModels.list(node.id).map((m) => m.id);

    const hidden = await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids: [...ids, foreign.id], action: "hide" });
    expect(hidden.status).toBe(200);
    expect(hidden.body.changed).toBe(3); // the foreign id is ignored, not acted on
    expect(repos.nodeModels.enabledModels(node.id)).toEqual([]);
    expect(repos.nodeModels.get(foreign.id).enabled).toBe(true); // untouched

    const shown = await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids: [ids[0]], action: "show" });
    expect(shown.body.changed).toBe(1);
    expect(repos.nodeModels.enabledModels(node.id)).toEqual(["m-alpha"]);

    const removed = await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids, action: "delete" });
    expect(removed.body.changed).toBe(3);
    expect(repos.nodeModels.list(node.id)).toHaveLength(0);
  });

  it("tests a selection and records each result on its row", async () => {
    const node = mkNode("p");
    mkKey(node);
    repos.nodeModels.import(node.id, ["m-alpha", "m-beta"]);
    const ids = repos.nodeModels.list(node.id).map((m) => m.id);

    const r = await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids, action: "test" });
    expect(r.status).toBe(200);
    expect(r.body.tested).toBe(2);
    expect(r.body.ok).toBe(2);
    expect(r.body.results.map((x) => x.model).sort()).toEqual(["m-alpha", "m-beta"]);
    expect(stubState.chatRequests).toHaveLength(2); // one real stream each
    for (const row of repos.nodeModels.list(node.id)) expect(row.lastTestOk).toBe(true);

    // still diagnostics: no usage, no budget, no breaker
    expect(repos.usage.query({ limit: 10 })).toHaveLength(0);
    expect(budgetState(1).spent).toBe(0);
    expect(repos.breakers.get(`node:${node.id}`)).toBeNull();
  });

  it("rejects an unknown action and an empty selection", async () => {
    const node = mkNode("p");
    const m = repos.nodeModels.create({ nodeId: node.id, model: "x" });
    expect((await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids: [m.id], action: "explode" })).status).toBe(400);
    expect((await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids: [], action: "hide" })).status).toBe(400);
    expect((await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids: ["ghost"], action: "hide" })).status).toBe(404);
  });

  it("needs a key to bulk-test", async () => {
    const node = mkNode("p");
    repos.nodeModels.import(node.id, ["m-alpha"]);
    const ids = repos.nodeModels.list(node.id).map((m) => m.id);
    const r = await call("POST", `/api/nodes/${node.id}/models/bulk`, { ids, action: "test" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("no_credentials");
  });
});

describe("model + key endpoints", () => {
  it("adds a manual model, tests it, and it appears in /v1/models", async () => {
    const node = mkNode("p");
    mkKey(node);

    const added = await call("POST", `/api/nodes/${node.id}/models`, { model: "hand-picked" });
    expect(added.status).toBe(201);
    expect(added.body.source).toBe("manual");

    const tested = await call("POST", `/api/nodes/${node.id}/models/${added.body.id}/test`, {});
    expect(tested.body.lastTestOk).toBe(true);
    expect(tested.body.lastTestTtftMs).toBeGreaterThanOrEqual(0);

    const ids = listModels(repos).data.map((m) => m.id);
    expect(ids).toContain("p/hand-picked");
  });

  it("rejects an empty model id", async () => {
    const node = mkNode("p");
    const r = await call("POST", `/api/nodes/${node.id}/models`, { model: "   " });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("bad_request");
  });

  it("toggles a model off and on, and deletes it", async () => {
    const node = mkNode("p");
    const m = repos.nodeModels.create({ nodeId: node.id, model: "toggler" });

    const off = await call("PUT", `/api/nodes/${node.id}/models/${m.id}`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    expect(listModels(repos).data.map((x) => x.id)).not.toContain("p/toggler");

    const on = await call("PUT", `/api/nodes/${node.id}/models/${m.id}`, { enabled: true });
    expect(on.body.enabled).toBe(true);

    const del = await call("DELETE", `/api/nodes/${node.id}/models/${m.id}`);
    expect(del.status).toBe(204);
    expect(repos.nodeModels.get(m.id)).toBeNull();
  });

  it("scopes model rows to their node", async () => {
    const a = mkNode("a");
    const b = mkNode("b");
    const m = repos.nodeModels.create({ nodeId: a.id, model: "only-a" });
    const r = await call("PUT", `/api/nodes/${b.id}/models/${m.id}`, { enabled: false });
    expect(r.status).toBe(404);
  });

  it("import reports what changed and needs a key", async () => {
    const node = mkNode("p");
    const noKey = await call("POST", `/api/nodes/${node.id}/models/import`, {});
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.message).toBe("no_credentials");

    mkKey(node);
    repos.nodeModels.create({ nodeId: node.id, model: "mine" });
    const r = await call("POST", `/api/nodes/${node.id}/models/import`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ imported: 3, kept: 1, stale: 0, listed: 3 });
    expect(r.body.models.map((m) => m.model)).toContain("mine");
  });

  it("surfaces an upstream failure on import instead of pretending it worked", async () => {
    const node = mkNode("p");
    mkKey(node);
    stubState.listFails = true;
    const r = await call("POST", `/api/nodes/${node.id}/models/import`, {});
    expect(r.status).toBe(502);
    expect(r.body.error.message).toBe("upstream_error");
    expect(repos.nodeModels.list(node.id)).toHaveLength(0);
  });
});
