// Provider param policy, end to end through the real chat handler, plus the classification that
// keeps a rejected request from being charged to the node.
//
// The policy table shipped as dead code — exported, documented, and never called — so no test
// covered it either. These pin the wiring with a rule whose behaviour is certain (Claude models
// reject `temperature`), and pin that a provider with no rule gets its body untouched, because
// the failure mode of a param policy is editing a request the provider would have accepted.
//
// The second half is the reported outage: b.ai 400s were recorded as NODE failures, so three
// requests opened the provider's breaker and every later request — for every model on it — came
// back 503 all_unavailable. "routy is broken" was one client-shaped error plus one misattribution.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { applyParamValues, stripUnsupportedParams } from "../core/translate/concerns/paramSupport.js";
import { subscribeLog } from "../lib/log.mjs";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubState;
let claudeNode, plainNode;

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

  claudeNode = repos.nodes.create({ name: "Claude", prefix: "anthropic", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/claude/v1` });
  plainNode = repos.nodes.create({ name: "bai", prefix: "bai", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/bai/v1` });
  repos.connections.create({ nodeId: claudeNode.id, name: "claude-key", credentials: { apiKey: "sk-claude" } });
  repos.connections.create({ nodeId: plainNode.id, name: "bai-key", credentials: { apiKey: "sk-bai" } });
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
  it("drops a param the matching rule names, and says so in the log", async () => {
    // Claude rejects temperature (the rule the table was written for, and dead until now).
    const lines = [];
    const stop = subscribeLog((text) => lines.push(JSON.parse(text)));
    try {
      expect((await chat("anthropic/claude-3-5-sonnet", { temperature: 0.7, top_p: 0.9 })).status).toBe(200);
    } finally {
      stop();
    }
    expect(lastBody()).not.toHaveProperty("temperature");
    expect(lastBody()).toMatchObject({ top_p: 0.9 }); // only what the rule names is touched

    // A policy that edits a request invisibly cannot be audited — that is how a wrong rule
    // (dropping a value the provider accepts) stays invisible.
    const line = lines.find((l) => l.tag === "PARAM");
    expect(line).toBeTruthy();
    expect(line.msg).toContain("temperature");
    expect(line.data).toMatchObject({ provider: "anthropic", model: "claude-3-5-sonnet" });
    expect(line.data.changes).toEqual([{ param: "temperature", from: 0.7 }]);
  });

  it("leaves a provider with no rule alone", async () => {
    // b.ai is deliberately absent from the table: on the reporting gateway its model accepts
    // every reasoning_effort value, so a rule would discard a level the provider honours.
    expect((await chat("bai/deepseek-v4.1-flash", { reasoning_effort: "medium" })).status).toBe(200);
    expect(lastBody().reasoning_effort).toBe("medium");
  });

  it("forwards everything else verbatim", async () => {
    await chat("bai/deepseek-v4.1-flash", { reasoning_effort: "medium", seed: 7, top_p: 0.9, custom_thing: { a: 1 } });
    expect(lastBody()).toMatchObject({ seed: 7, top_p: 0.9, custom_thing: { a: 1 }, reasoning_effort: "medium" });
  });
});

describe("what a rejection is allowed to cost", () => {
  it("returns the provider's 400 to the client without charging the node", async () => {
    stubState.reject = (body) => (body?.reasoning_effort === "medium" ? { status: 400, message: "MaaS reject: reasoning_effort medium" } : null);

    for (let i = 0; i < 3; i++) {
      const r = await chat("bai/m1", { reasoning_effort: "medium" });
      expect(r.status).toBe(400); // the caller's error, reported as one
    }
    // Three of these used to open the node's breaker and 503 every later request.
    const breaker = repos.breakers.get(`node:${plainNode.id}`);
    expect(breaker?.failures ?? 0).toBe(0);
    expect(breaker?.openUntil ?? null).toBeNull();

    // and the node is still serving everything else
    expect((await chat("bai/m1", {})).status).toBe(200);
  }, 20_000);
});

describe("the rule vocabulary", () => {
  it("drops or replaces an unaccepted value, keeps an accepted one, and reports each change", () => {
    const spec = { reasoning_effort: { allow: ["low", "high", "max"], otherwise: null } };

    const dropped = { reasoning_effort: "medium", top_p: 0.9 };
    expect(applyParamValues(dropped, spec)).toEqual([{ param: "reasoning_effort", from: "medium", to: undefined }]);
    expect(dropped).not.toHaveProperty("reasoning_effort");
    expect(dropped.top_p).toBe(0.9); // only the named param is touched

    // a string `otherwise` keeps the field and changes the value — the alternative to dropping
    const replaced = { reasoning_effort: "medium" };
    expect(applyParamValues(replaced, { reasoning_effort: { allow: ["low", "high"], otherwise: "high" } })).toEqual([{ param: "reasoning_effort", from: "medium", to: "high" }]);
    expect(replaced.reasoning_effort).toBe("high");

    const kept = { reasoning_effort: "low" };
    expect(applyParamValues(kept, spec)).toEqual([]);
    expect(kept.reasoning_effort).toBe("low");
  });

  it("leaves an absent value absent rather than writing one", () => {
    const empty = applyParamValues({}, { reasoning_effort: { allow: ["low"], otherwise: "high" } });
    expect(empty).toEqual([]);
    const nulled = applyParamValues({ reasoning_effort: null }, { reasoning_effort: { allow: ["low"], otherwise: "high" } });
    expect(nulled).toEqual([]);
  });

  it("scopes a rule to its provider and its model match", () => {
    const untouched = { temperature: 1.1 };
    expect(stripUnsupportedParams("someone-else", "gpt-5.4", untouched)).toEqual([]);
    expect(untouched.temperature).toBe(1.1);

    const claude = { temperature: 1.1, top_p: 0.5 };
    expect(stripUnsupportedParams("anthropic", "claude-3-5-sonnet", claude)).toEqual([{ param: "temperature", from: 1.1, to: undefined }]);
    expect(claude).not.toHaveProperty("temperature");
    expect(claude.top_p).toBe(0.5);

    // the rule is matched on the model id, so a non-Claude model on the same provider is untouched
    const other = { temperature: 1.1 };
    expect(stripUnsupportedParams("anthropic", "some-other-model", other)).toEqual([]);
    expect(other.temperature).toBe(1.1);
  });

  it("reports nothing for a body that cannot carry params", () => {
    expect(stripUnsupportedParams("anthropic", "claude-3-5-sonnet", undefined)).toEqual([]);
    const noModel = { temperature: 1.1 };
    expect(stripUnsupportedParams("anthropic", "", noModel)).toEqual([]);
    expect(noModel.temperature).toBe(1.1);
  });
});
