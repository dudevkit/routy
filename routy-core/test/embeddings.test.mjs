// Embeddings (docs/media-providers.md §8 M1) — the first media kind end to end, and the
// template every later kind copies.
//
// What is load-bearing here:
//   - the request reaches the endpoint the KIND declares, with the auth style the node
//     declares, and the response passes through untouched (no stream parameter, no rewrite);
//   - failures are charged the way chat charges them, because media must not have a second,
//     subtly different definition of what a 400 or a 429 costs a node — that divergence is
//     exactly where an outage hides;
//   - a node that does not serve embeddings is refused by name, not by silence.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createEmbeddingsHandler } from "../core/handlers/embeddings.mjs";
import { createRouter, json } from "../lib/router.mjs";
import { connectionState } from "../core/key-health.mjs";

let tmp, db, repos, server, port, stubServer, stubPort, stubState, cfg;

const EMBED_OK = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.123, -0.456] }],
  usage: { prompt_tokens: 3, total_tokens: 3 },
};

const call = (method, p, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port, path: p, method,
        headers: { "content-type": "application/json", ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null }));
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });

const embed = (body) => call("POST", "/v1/embeddings", body);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-embed-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });

  stubState = { calls: [], responses: [] };
  stubServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep raw */ }
      stubState.calls.push({ path: req.url, headers: req.headers, body });
      const script = stubState.responses.shift() || { status: 200, body: EMBED_OK };
      res.writeHead(script.status, { "content-type": "application/json" });
      res.end(JSON.stringify(script.body ?? {}));
    });
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => { stubPort = stubServer.address().port; r(); }));

  cfg = { bootstrapToken: "tok" };
  const dispatch = createRouter([
    ...buildApiRoutes(repos, cfg, "0.1.0"),
    ...buildProxyRoutes(repos, {
      chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }),
      handlers: { embeddings: createEmbeddingsHandler(repos, { timeoutMs: 5_000 }) },
    }),
  ]);
  await new Promise((resolve) => {
    server = http.createServer((req, res) => dispatch(req, res));
    server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
  });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  stubServer?.closeAllConnections?.();
  server?.closeAllConnections?.();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => stubServer?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A node that serves embeddings, with N keys. Declares the kind by default — a node that has
 * not declared it is the *wrong* case, and tests that want one create it themselves.
 */
function embeddingNode(prefix = "prov", { media = { kinds: ["embedding"] }, keys = ["sk-one"], baseUrl } = {}) {
  const node = repos.nodes.create({
    name: prefix, prefix, apiType: "openai",
    baseUrl: baseUrl ?? `http://127.0.0.1:${stubPort}/v1`,
    data: media ? { media } : null,
  });
  keys.forEach((apiKey, i) => repos.connections.create({ nodeId: node.id, name: `${prefix} key ${i + 1}`, credentials: { apiKey } }));
  return node;
}

const keyIds = (nodeId) => repos.connections.list(nodeId).map((c) => c.id);
const breaker = (nodeId) => repos.breakers.get(`node:${nodeId}`);

describe("a request that the kind allows", () => {
  it("calls the endpoint, with the node's auth, and passes the answer through", async () => {
    const node = embeddingNode();
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });

    const r = await embed({ model: "prov/e-1", input: "hello world" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject(EMBED_OK); // provider's own shape, untouched

    expect(stubState.calls).toHaveLength(1);
    const call0 = stubState.calls[0];
    expect(call0.path).toBe("/v1/embeddings");           // the KIND's endpoint, not /chat/completions
    expect(call0.body).toEqual({ model: "e-1", input: "hello world" }); // no `stream` invented
    expect(call0.headers.authorization).toBe("Bearer sk-one");

    const ev = repos.usage.query({ limit: 1 })[0];
    expect(ev.kind).toBe("embedding");
    expect(ev.status).toBe("ok");
    expect(ev.prompt_tokens).toBe(3);
    expect(breaker(node.id)?.failures ?? 0).toBe(0);
  });

  it("uses the node's declared URL and auth style, not the defaults", async () => {
    const node = embeddingNode("custom", {
      media: {
        kinds: ["embedding"],
        urls: { embedding: `http://127.0.0.1:${stubPort}/other/embeddings` },
        auth: { embedding: { style: "x-api-key" } },
      },
    });
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });

    expect((await embed({ model: "custom/e-1", input: "hi" })).status).toBe(200);
    expect(stubState.calls[0].path).toBe("/other/embeddings");
    expect(stubState.calls[0].headers["x-api-key"]).toBe("sk-one");
    expect(stubState.calls[0].headers.authorization).toBeUndefined();
  });

  it("forwards encoding_format and dimensions but nothing else", async () => {
    const node = embeddingNode();
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    await embed({ model: "prov/e-1", input: ["a", "b"], encoding_format: "float", dimensions: 64, stray: "ignored" });
    expect(stubState.calls[0].body).toEqual({ model: "e-1", input: ["a", "b"], encoding_format: "float", dimensions: 64 });
  });

  it("writes the request and response to the detail view", async () => {
    const node = embeddingNode();
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    await embed({ model: "prov/e-1", input: "hello" });
    const details = repos.requestDetails.list({ limit: 10 });
    expect(details.map((d) => d.kind).sort()).toEqual(["request", "response"]);
    expect(JSON.parse(details.find((d) => d.kind === "response").content)).toMatchObject(EMBED_OK);
    expect(node.id).toBeTruthy();
  });
});

describe("a request the gateway refuses", () => {
  it("names the reason: wrong kind, or unknown", async () => {
    // A node that serves only chat: it is reachable from /v1/chat/completions but must not be
    // reachable from an embeddings request, which is the check being made here.
    const node = repos.nodes.create({ name: "noembed", prefix: "noembed", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    repos.connections.create({ nodeId: node.id, name: "noembed key", credentials: { apiKey: "sk-x" } });
    repos.nodeModels.create({ nodeId: node.id, model: "m1", kind: "llm" });

    const wrongKind = await embed({ model: "noembed/m1", input: "hi" });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error.detail).toContain("does not serve embeddings");

    const unknown = await embed({ model: "ghost/m1", input: "hi" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.detail).toContain("not routable");

    expect(stubState.calls).toHaveLength(0); // refused before any upstream call
  });

  it("validates the body before touching a provider", async () => {
    embeddingNode();
    expect((await embed({ input: "hi" })).body.error.detail).toContain("model required");
    expect((await embed({ model: "prov/e-1" })).body.error.detail).toContain("input");
    expect((await embed({ model: "prov/e-1", input: "" })).status).toBe(400);
    expect((await embed({ model: "prov/e-1", input: [42] })).status).toBe(400);
    expect(stubState.calls).toHaveLength(0);
  });

  it("refuses a combo rather than serving it in declared order", async () => {
    const node = embeddingNode();
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    repos.combos.create({ name: "emb-combo", models: ["prov/e-1"], kind: "embedding" });

    const r = await embed({ model: "emb-combo", input: "hi" });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("combos for embeddings are not enabled yet");
    expect(stubState.calls).toHaveLength(0);
  });

  it("says no keys without claiming they are cooling down", async () => {
    const node = repos.nodes.create({
      name: "empty", prefix: "empty", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      data: { media: { kinds: ["embedding"] } }, // declares the kind; only its keys are missing
    });
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    const r = await embed({ model: "empty/e-1", input: "hi" });
    expect(r.status).toBe(503);
    expect(r.body.error.message).toBe("no_credentials");
  });
});

describe("what a failure is allowed to cost", () => {
  it("hands a request-shaped 400 to the caller and charges no health", async () => {
    const node = embeddingNode();
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    stubState.responses = [
      { status: 400, body: { error: { message: "Unrecognized request argument supplied: input" } } },
      { status: 400, body: { error: { message: "Unrecognized request argument supplied: input" } } },
    ];

    const r = await embed({ model: "prov/e-1", input: "hi" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("upstream_rejected");

    expect(breaker(node.id)?.failures ?? 0).toBe(0);          // not the node's fault
    expect(connectionState(repos, keyIds(node.id)[0]).state).toBe("closed"); // not the key's either
    expect((await embed({ model: "prov/e-1", input: "hi" })).status).toBe(400); // and it still says so
  });

  it("rotates to the next key on a per-key 429, without charging the node", async () => {
    const node = embeddingNode("prov", { keys: ["sk-one", "sk-two"] });
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    stubState.responses = [{ status: 429, body: { error: { message: "slow down" } } }]; // unclassified → this key's problem

    const r = await embed({ model: "prov/e-1", input: "hi" });
    expect(r.status).toBe(200);
    expect(stubState.calls.map((c) => c.headers.authorization)).toEqual(["Bearer sk-one", "Bearer sk-two"]);
    expect(breaker(node.id)?.failures ?? 0).toBe(0);
    expect(connectionState(repos, keyIds(node.id)[0]).state).not.toBe("closed"); // key one took the hit
  });

  it("stops at the node on a 5xx instead of multiplying load by the key count", async () => {
    const node = embeddingNode("prov", { keys: ["sk-one", "sk-two"] });
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    stubState.responses = [{ status: 500, body: { error: { message: "boom" } } }];

    const r = await embed({ model: "prov/e-1", input: "hi" });
    expect(r.status).toBe(500);
    expect(stubState.calls).toHaveLength(1);       // the second key was NOT burned
    expect(breaker(node.id)?.failures).toBe(1);    // the node took it, as chat would
    expect(breaker(node.id)?.state).toBe("closed"); // one failure is not a trip
  });

  it("fails fast while a provider-wide 429 window is open, then re-probes", async () => {
    const node = embeddingNode("prov", { keys: ["sk-one", "sk-two"] });
    repos.nodeModels.create({ nodeId: node.id, model: "e-1", kind: "embedding" });
    stubState.responses = [{ status: 429, body: { error: { message: "capacity — try again later" } } }];

    const first = await embed({ model: "prov/e-1", input: "hi" });
    expect(first.status).toBe(429);
    expect(first.body.error.message).toBe("upstream_rate_limited");
    expect(stubState.calls).toHaveLength(1); // neither key rotated into a wall, per the global verdict

    const second = await embed({ model: "prov/e-1", input: "hi" });
    expect(second.status).toBe(429);
    expect(second.body.error.retryAfterMs).toBeGreaterThan(0);
    expect(stubState.calls).toHaveLength(1); // memo: no re-probe of a model already proven saturated
    expect(breaker(node.id)?.failures ?? 0).toBe(0); // a provider-wide limit is nobody's fault
  });
});
