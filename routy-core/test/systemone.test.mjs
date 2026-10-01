// System One (kind `systemone`).
//
// The claim this file defends is the one thing that makes this kind different from every other
// media kind: routy does NOT translate the body. The caller's `{ state, questions }` reaches the
// provider as written, with exactly one field changed (the model id, from routy's prefixed form to
// the provider's own), and the provider's answer comes back as written too. A test that only
// checked "200 and some JSON" would pass for an implementation that quietly reshaped both — so
// these assert the bytes on the wire, in both directions.
//
// The rest is the media machinery every kind inherits, and is checked here only where System One
// can differ from the others: it is the first kind that needs no request mapping, so its refusal
// path is about a missing URL rather than a missing mapping.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createSystemoneHandler, systemoneSessionId } from "../core/handlers/systemone.mjs";
import { createRouter, json } from "../lib/router.mjs";

let tmp, db, repos, server, port, stubServer, stubPort, stubState;

const post = (p, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

/** Exactly the document 9Router's System One card shows, and exactly what the upstream answers. */
const UPSTREAM_ANSWER = {
  model: "jev-1.13-free",
  answers: { is_urgent: { type: "noul", noul: 0.95 } },
  usage: { input_tokens: 290, output_tokens: 23 },
  cost: "0",
};

const QUESTIONS = { is_urgent: { type: "noul", instructions: "Does this request require urgent attention?" } };
const STATE = "My payments have failed for three days and I am losing sales. Please help now.";

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-systemone-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });

  stubState = { calls: [], responses: [] };
  stubServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
      stubState.calls.push({ url: req.url, method: req.method, headers: req.headers, body });
      const script = stubState.responses.shift();
      if (script) {
        res.writeHead(script.status, { "content-type": script.contentType ?? "application/json" });
        return res.end(typeof script.body === "string" ? script.body : JSON.stringify(script.body ?? {}));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(UPSTREAM_ANSWER));
    });
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => { stubPort = stubServer.address().port; r(); }));

  const dispatch = createRouter([
    ...buildApiRoutes(repos, { bootstrapToken: "tok" }, "0.1.0"),
    ...buildProxyRoutes(repos, {
      chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }),
      handlers: { systemone: createSystemoneHandler(repos, { timeoutMs: 5_000 }) },
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

/** A node that declares the kind, with one key and one model row. */
function systemoneNode(prefix, { model = "jev-1.13-free", keys = ["sk-zen"], url = `http://127.0.0.1:${stubPort}/zen/v1/systemone`, auth = "bearer", headers } = {}) {
  const node = repos.nodes.create({
    name: prefix, prefix, apiType: "openai",
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    data: {
      media: {
        kinds: ["systemone"],
        urls: { systemone: url },
        auth: { systemone: { style: auth } },
        map: { systemone: { headers: headers ?? { "x-opencode-client": "desktop" } } },
      },
    },
  });
  keys.forEach((apiKey, i) => repos.connections.create({ nodeId: node.id, name: `${prefix} key ${i + 1}`, credentials: { apiKey } }));
  repos.nodeModels.create({ nodeId: node.id, model, kind: "systemone" });
  return node;
}

describe("the body is forwarded, not translated", () => {
  it("sends state and questions as written, with the provider's own model id", async () => {
    systemoneNode("zen");
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });

    expect(r.status).toBe(200);
    const call = stubState.calls[0];
    expect(call.url).toBe("/zen/v1/systemone");
    expect(call.method).toBe("POST");
    // The prefixed id routy was asked for is NOT what the provider is called with.
    expect(call.body.model).toBe("jev-1.13-free");
    expect(call.body.state).toBe(STATE);
    expect(call.body.questions).toEqual(QUESTIONS);
    // The provider's static headers survive, and the request carries a session id in the shape
    // the upstream's own clients use.
    expect(call.headers["x-opencode-client"]).toBe("desktop");
    expect(call.headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(call.headers.authorization).toBe("Bearer sk-zen");
  });

  it("keeps a provider-namespaced model id whole", async () => {
    systemoneNode("orouter", { model: "typesafe/jev-1.13" });
    await post("/v1/systemone", { model: "orouter/typesafe/jev-1.13", state: STATE, questions: QUESTIONS });
    // Only routy's own prefix is stripped: `typesafe/` is part of the provider's id.
    expect(stubState.calls[0].body.model).toBe("typesafe/jev-1.13");
  });

  it("returns the provider's answer untouched", async () => {
    systemoneNode("zen");
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });
    // Byte-for-byte what the provider said — no `provider`, no envelope, no renamed fields. A
    // caller parsing `answers.is_urgent.noul` gets it, and nothing it did not ask for.
    expect(r.body).toEqual(UPSTREAM_ANSWER);
  });

  it("forwards fields it does not know about", async () => {
    systemoneNode("zen");
    await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS, locale: "id-ID" });
    // The provider's schema is the caller's business: routy drops nothing it did not put there.
    expect(stubState.calls[0].body.locale).toBe("id-ID");
  });

  it("serves a keyless provider with no credential at all", async () => {
    // OpenCode Zen's free half needs nothing, so the node gets no connection and must still be
    // reachable: a placeholder key would be a step that buys nothing, and one that routy would
    // then never send.
    systemoneNode("zen-free", { auth: "none", keys: [] });
    const r = await post("/v1/systemone", { model: "zen-free/jev-1.13-free", state: STATE, questions: QUESTIONS });

    expect(r.status).toBe(200);
    expect(stubState.calls[0].headers.authorization).toBeUndefined();
    expect(r.body).toEqual(UPSTREAM_ANSWER);
    const row = repos.usage.query({ limit: 1 })[0];
    expect(row.status).toBe("ok");
    expect(row.connection_id).toBeNull(); // the anonymous connection, recorded as no connection
  });

  it("gives a fresh session id to every request", () => {
    const ids = new Set(Array.from({ length: 50 }, () => systemoneSessionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });
});

describe("what routy refuses before it calls anyone", () => {
  it("serves a node that carries no mapping at all", async () => {
    // The mapping is the one thing this kind does not need: the request IS the provider's format.
    // A node configured with nothing but a URL and a kind must therefore work — and must not be
    // asked for a mapping it has no use for.
    const node = repos.nodes.create({
      name: "bare", prefix: "bare", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      data: { media: { kinds: ["systemone"], urls: { systemone: `http://127.0.0.1:${stubPort}/zen/v1/systemone` }, auth: { systemone: { style: "bearer" } } } },
    });
    repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-bare" } });
    repos.nodeModels.create({ nodeId: node.id, model: "jev-1.13-free", kind: "systemone" });

    const r = await post("/v1/systemone", { model: "bare/jev-1.13-free", state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(200);
    expect(stubState.calls[0].headers.authorization).toBe("Bearer sk-bare");
    expect(stubState.calls[0].headers["x-opencode-session"]).toMatch(/^ses_/);
  });

  it("rejects a request with no state, and never reaches the provider", async () => {
    systemoneNode("zen");
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", questions: QUESTIONS });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("state");
    expect(stubState.calls).toHaveLength(0);
  });

  it("rejects questions that are not an object", async () => {
    systemoneNode("zen");
    for (const questions of [undefined, null, [], "is it urgent?", 7]) {
      const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions });
      expect(r.status, JSON.stringify(questions)).toBe(400);
      expect(r.body.error.detail).toContain("questions");
    }
    expect(stubState.calls).toHaveLength(0);
  });

  it("rejects a request with no model", async () => {
    systemoneNode("zen");
    const r = await post("/v1/systemone", { state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("model");
  });

  it("refuses a node that does not declare the kind", async () => {
    const node = repos.nodes.create({ name: "chatonly", prefix: "chatonly", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x" } });
    const r = await post("/v1/systemone", { model: "chatonly/m1", state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("does not serve System One");
  });

  it("refuses a node with no endpoint, naming what to set", async () => {
    const node = repos.nodes.create({
      name: "nourl", prefix: "nourl", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      data: { media: { kinds: ["systemone"] } },
    });
    repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x" } });
    repos.nodeModels.create({ nodeId: node.id, model: "jev-1.13-free", kind: "systemone" });

    const r = await post("/v1/systemone", { model: "nourl/jev-1.13-free", state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("no URL for systemone");
    expect(stubState.calls).toHaveLength(0); // a misconfigured provider is not called to find out
  });
});

describe("the media machinery System One inherits", () => {
  it("records the provider's token counts under routy's own names", async () => {
    systemoneNode("zen");
    await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });

    const row = repos.usage.query({ limit: 1 })[0];
    expect(row.kind).toBe("systemone");
    expect(row.status).toBe("ok");
    expect(row.model).toBe("zen/jev-1.13-free"); // what the CALLER asked for, not the upstream id
    expect(row.prompt_tokens).toBe(290);
    expect(row.completion_tokens).toBe(23);
  });

  it("leaves the token columns empty when the provider reports none", async () => {
    systemoneNode("zen");
    stubState.responses = [{ status: 200, body: { model: "jev-1.13-free", answers: {} } }];
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(200);
    const row = repos.usage.query({ limit: 1 })[0];
    expect(row.prompt_tokens).toBeNull();
    expect(row.completion_tokens).toBeNull();
  });

  it("rotates to the next key when one hits a rate limit", async () => {
    systemoneNode("zen", { keys: ["sk-one", "sk-two"] });
    stubState.responses = [{ status: 429, body: { error: { message: "slow down" } } }];
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });

    expect(r.status).toBe(200);
    expect(stubState.calls).toHaveLength(2);
    expect(stubState.calls[0].headers.authorization).not.toBe(stubState.calls[1].headers.authorization);
    expect(repos.usage.query({ limit: 1 })[0].status).toBe("ok");
  });

  it("moves past a key the provider rejects on auth", async () => {
    // The live case this mirrors: a Zen key without a workspace answers 401 for `jev-1.13`. A
    // second key that can serve is still reachable — the 401 is a strike on one credential, not
    // a verdict on the provider.
    systemoneNode("zen", { keys: ["sk-no-workspace", "sk-good"] });
    stubState.responses = [{ status: 401, body: { error: { message: "Rate-limited Zen models require a workspace" } } }];
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });

    expect(r.status).toBe(200);
    expect(stubState.calls).toHaveLength(2);
    expect(stubState.calls[1].headers.authorization).toBe("Bearer sk-good");
  });

  it("passes a request-shaped rejection through with the provider's status", async () => {
    systemoneNode("zen");
    stubState.responses = [{ status: 400, body: { error: { message: "model not supported for this account" } } }];
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("upstream_rejected");
    expect(r.body.error.detail).toContain("not supported");
  });

  it("treats a non-JSON answer as an upstream failure", async () => {
    systemoneNode("zen");
    stubState.responses = [{ status: 200, contentType: "text/html", body: "<html>nope</html>" }];
    const r = await post("/v1/systemone", { model: "zen/jev-1.13-free", state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toBe("all_routes_failed");
    expect(r.body.error.detail).toContain("non-JSON");
  });

  it("fails over to the next combo member and says which one served it", async () => {
    systemoneNode("alpha");
    systemoneNode("beta");
    repos.combos.create({ name: "systemone-combo", models: ["alpha/jev-1.13-free", "beta/jev-1.13-free"], kind: "systemone" });
    stubState.responses = [{ status: 500, body: { error: { message: "boom" } } }]; // alpha fails

    const r = await post("/v1/systemone", { model: "systemone-combo", state: STATE, questions: QUESTIONS });
    expect(r.status).toBe(200);
    expect(stubState.calls).toHaveLength(2); // alpha, then beta
    expect(repos.usage.query({ limit: 1 })[0].model).toBe("systemone-combo");
  });
});
