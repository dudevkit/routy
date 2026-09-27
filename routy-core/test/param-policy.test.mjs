// Provider param policy, end to end through the real chat handler, plus the classification that
// keeps a rejected request from being charged to the node.
//
// Reported from a live setup: Hermes sends `reasoning_effort: "medium"` on every request, b.ai
// answers 400 for that value (and for none/minimal; low/high/max are accepted), and the 400 was
// recorded as a NODE failure — so three requests opened the provider's breaker and every later
// request, for every model on it, came back 503 all_unavailable. "routy is broken" was one
// unsupported parameter plus one misattribution.
//
// Both halves are pinned here: what leaves for the provider, and what the provider's rejection
// is allowed to cost.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { applyParamValues, stripUnsupportedParams } from "../core/translate/concerns/paramSupport.js";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubState;
let bai, other;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "param-policy-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  const handler = createChatHandler(repos);

  // `reject` lets a test decide what the "provider" refuses, so the client's view and the
  // node's health can be asserted separately.
  stubState = { bodies: [], reject: null };
  stubPort = await new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        stubState.bodies.push(body);
        const rejection = stubState.reject?.(body);
        if (rejection) {
          res.writeHead(rejection.status, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: rejection.message, type: "invalid_request_error" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });

  handlerPort = await new Promise((resolve) => {
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
  });

  // The provider key comes from the node's prefix when it is not set explicitly — which is how
  // a node the user called "bai" gets b.ai's rules without any extra setup.
  bai = repos.nodes.create({ name: "bai", prefix: "bai", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/bai/v1` });
  other = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/a/v1` });
  repos.connections.create({ nodeId: bai.id, name: "bai-key", credentials: { apiKey: "sk-bai" } });
  repos.connections.create({ nodeId: other.id, name: "a-key", credentials: { apiKey: "sk-a" } });
  repos.settings.update({ requireApiKey: false });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  handlerServer?.closeAllConnections?.();
  stubServer?.closeAllConnections?.();
  await new Promise((r) => handlerServer?.close(r));
  await new Promise((r) => stubServer?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const chat = (model, extra = {}) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "x" }], ...extra });
    const req = http.request(
      { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); },
    );
    req.on("error", reject);
    req.end(payload);
  });

const lastBody = () => stubState.bodies.at(-1);

describe("what leaves for the provider", () => {
  it("drops a value the provider rejects, and passes the values it accepts", async () => {
    // Measured against b.ai: medium/none/minimal → 400, low/high/max → 200, absent → 200.
    expect((await chat("bai/m1", { reasoning_effort: "medium" })).status).toBe(200);
    expect(lastBody()).not.toHaveProperty("reasoning_effort");

    expect((await chat("bai/m1", { reasoning_effort: "none" })).status).toBe(200);
    expect(lastBody()).not.toHaveProperty("reasoning_effort");

    // the accepted values must survive — dropping the field outright would discard them too
    expect((await chat("bai/m1", { reasoning_effort: "high" })).status).toBe(200);
    expect(lastBody().reasoning_effort).toBe("high");
    expect((await chat("bai/m1", { reasoning_effort: "max", temperature: 0.3 })).status).toBe(200);
    expect(lastBody()).toMatchObject({ reasoning_effort: "max", temperature: 0.3 });
  });

  it("leaves a provider with no rule alone", async () => {
    expect((await chat("a/m1", { reasoning_effort: "medium" })).status).toBe(200);
    expect(lastBody().reasoning_effort).toBe("medium");
  });

  it("still forwards everything else verbatim", async () => {
    // The policy is a scalpel, not a rewrite: unknown params belong to the caller.
    await chat("bai/m1", { reasoning_effort: "medium", seed: 7, top_p: 0.9, custom_thing: { a: 1 } });
    expect(lastBody()).toMatchObject({ seed: 7, top_p: 0.9, custom_thing: { a: 1 } });
  });
});

describe("what a rejection is allowed to cost", () => {
  it("returns the provider's 400 to the client without charging the node", async () => {
    stubState.reject = (body) => (body?.reasoning_effort === "medium" ? { status: 400, message: "MaaS reject: reasoning_effort medium" } : null);

    for (let i = 0; i < 3; i++) {
      const r = await chat("a/m1", { reasoning_effort: "medium" });
      expect(r.status).toBe(400); // the caller's error, reported as one
    }
    // Three of these used to open the node's breaker and 503 every later request.
    const breaker = repos.breakers.get(`node:${other.id}`);
    expect(breaker?.failures ?? 0).toBe(0);
    expect(breaker?.openUntil ?? null).toBeNull();

    // and the node is still serving everything else
    expect((await chat("a/m1", {})).status).toBe(200);
  }, 20_000);
});

describe("the rule vocabulary", () => {
  it("drops or replaces an unaccepted value, and keeps an accepted one", () => {
    const dropped = applyParamValues({ reasoning_effort: "medium", top_p: 0.9 }, { reasoning_effort: { allow: ["low", "high", "max"], otherwise: null } });
    expect(dropped).not.toHaveProperty("reasoning_effort");
    expect(dropped.top_p).toBe(0.9); // only the named param is touched

    // a string `otherwise` is the alternative to dropping: keep the field, change the value
    const replaced = applyParamValues({ reasoning_effort: "medium" }, { reasoning_effort: { allow: ["low", "high", "max"], otherwise: "high" } });
    expect(replaced.reasoning_effort).toBe("high");

    const kept = applyParamValues({ reasoning_effort: "low" }, { reasoning_effort: { allow: ["low", "high", "max"], otherwise: "high" } });
    expect(kept.reasoning_effort).toBe("low");
  });

  it("leaves an absent value absent rather than writing one", () => {
    const empty = applyParamValues({}, { reasoning_effort: { allow: ["low"], otherwise: "high" } });
    expect(empty).not.toHaveProperty("reasoning_effort");
    const nulled = applyParamValues({ reasoning_effort: null }, { reasoning_effort: { allow: ["low"], otherwise: "high" } });
    expect(nulled.reasoning_effort).toBeNull();
  });

  it("scopes a rule to its provider and its model match", () => {
    const untouched = { temperature: 1.1 };
    stripUnsupportedParams("someone-else", "gpt-5.4", untouched);
    expect(untouched.temperature).toBe(1.1);

    // the pre-existing rule this table was written for: Claude rejects temperature
    const claude = { temperature: 1.1, top_p: 0.5 };
    stripUnsupportedParams("anthropic", "claude-3-5-sonnet", claude);
    expect(claude).not.toHaveProperty("temperature");
    expect(claude.top_p).toBe(0.5); // only what the rule names
  });

  it("ignores a body that cannot carry params", () => {
    expect(() => stripUnsupportedParams("bai", "anything", undefined)).not.toThrow();
    const noModel = { reasoning_effort: "medium" };
    stripUnsupportedParams("bai", "", noModel);
    expect(noModel.reasoning_effort).toBe("medium"); // no model → no rule
  });
});
