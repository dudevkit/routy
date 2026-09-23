// P1.5 integration — full /v1/chat/completions path: auth → routing → executor →
// SSE pump → usage/breakers. Hermetic stub + temp db.
// Topology: post() → handlerServer (createChatHandler) → stub upstream server.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubState;

function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        stubState.requests.push(JSON.parse(body));
        stubState.handler(req, res, stubState.requests.length);
      });
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });
}

function sseResponse(res, content = "hi") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-chat-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  const handler = createChatHandler(repos);

  stubState = { requests: [], handler: (req, res) => sseResponse(res) };
  stubPort = await startStub();

  handlerPort = await new Promise((resolve) => {
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
  });

  const node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
  repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "k-a" } });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed by a timed-out test */ }
  handlerServer.closeAllConnections?.();
  stubServer.closeAllConnections?.();
  await new Promise((r) => handlerServer.close(r));
  await new Promise((r) => stubServer.close(r));
});
function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("chat handler (end-to-end)", () => {
  it("streams openai passthrough with exact usage recorded", async () => {
    repos.settings.update({ requireApiKey: false });
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.body).toContain('"content":"hi"');
    expect(r.body.trim().endsWith("data: [DONE]")).toBe(true);
    repos.usage.flush();
    const events = repos.usage.query({ limit: 10 });
    expect(events.length).toBe(1);
    expect(events[0].status).toBe("ok");
    expect(events[0].prompt_tokens).toBe(7); // exact from upstream usage
    expect(events[0].completion_tokens).toBe(1);
  });

  it("enforces api key when required", async () => {
    repos.apiKeys.create("k1");
    const r = await post({ model: "a/m1", messages: [] });
    expect(r.status).toBe(401);
    expect(r.body).toContain("auth_error");
  });

  it("accepts a valid api key", async () => {
    const { key } = repos.apiKeys.create("k1");
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] }, { authorization: `Bearer ${key}` });
    expect(r.status).toBe(200);
  });

  it("accepts the Anthropic x-api-key header", async () => {
    // Claude Code sends this when configured with ANTHROPIC_API_KEY, which is its
    // more common setting. A gateway that only reads Authorization rejects it.
    const { key } = repos.apiKeys.create("k1");
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] }, { "x-api-key": key });
    expect(r.status).toBe(200);
  });

  it("still rejects a wrong key sent as x-api-key", async () => {
    repos.apiKeys.create("k1");
    const r = await post({ model: "a/m1", messages: [] }, { "x-api-key": "sk-not-a-real-key" });
    expect(r.status).toBe(401);
  });

  it("404s unresolvable models", async () => {
    repos.settings.update({ requireApiKey: false });
    const r = await post({ model: "ghost/m1", messages: [] });
    expect(r.status).toBe(404);
    expect(r.body).toContain("invalid_model");
  });

  it("returns 503 after breaker opens on repeated failures", async () => {
    repos.settings.update({ requireApiKey: false });
    repos.nodes.update(repos.nodes.list()[0].id, { data: { retry: { 503: { attempts: 0 } } } });
    stubState.handler = (req, res) => res.writeHead(503).end("down");
    for (let i = 0; i < 3; i++) {
      await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    }
    const breaker = repos.breakers.get(`node:${repos.nodes.list()[0].id}`);
    expect(breaker.state).toBe("open");
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(503);
    expect(r.body).toContain("all_unavailable");
  });

  it("combo falls back to second node on first-node failure", async () => {
    repos.settings.update({ requireApiKey: false });
    const bad = repos.nodes.create({ name: "Bad", prefix: "bad", apiType: "openai", baseUrl: `http://127.0.0.1:1/v1`, data: { retry: { 502: { attempts: 0 } } } });
    repos.connections.create({ nodeId: bad.id, name: "k", credentials: { apiKey: "k-b" } });
    repos.combos.create({ name: "pair", models: ["bad/m", "a/m"] });
    const r = await post({ model: "pair", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(200);
    expect(r.body).toContain("[DONE]");
    expect(repos.breakers.get(`node:${bad.id}`).failures).toBe(1);
    repos.usage.flush();
    const events = repos.usage.query({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].node_id).toBe(repos.nodes.byPrefix("a").id); // served by healthy node
  });

  it("non-streaming returns JSON body", async () => {
    repos.settings.update({ requireApiKey: false });
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", usage: { prompt_tokens: 5, completion_tokens: 2 }, choices: [{ message: { content: "hello" } }] }));
    };
    const r = await post({ model: "a/m1", stream: false, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.choices[0].message.content).toBe("hello");
    repos.usage.flush();
    expect(repos.usage.query({ limit: 1 })[0].completion_tokens).toBe(2);
  });

  it("RTK compresses large tool_result bodies before dispatch (default-on)", async () => {
    repos.settings.update({ requireApiKey: false });
    const lines = ["diff --git a/src/app.js b/src/app.js", "--- a/src/app.js", "+++ b/src/app.js"];
    for (let h = 0; h < 10; h++) {
      lines.push(`@@ -${h * 120 + 1},120 +${h * 120 + 1},124 @@ function block${h}()`);
      for (let i = 0; i < 120; i++) lines.push(`   context line ${h}-${i} const value = compute(${i});`);
      for (let i = 0; i < 4; i++) lines.push(`+  added line ${h}-${i} const fresh = compute(${i});`);
    }
    const DIFF = lines.join("\n");
    const r = await post({
      model: "a/m1", stream: true,
      messages: [
        { role: "user", content: "check diff" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "git_diff", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: DIFF },
      ],
    });
    expect(r.status).toBe(200);
    const sent = stubState.requests[0].messages.find((m) => m.role === "tool");
    const sentContent = typeof sent.content === "string" ? sent.content : JSON.stringify(sent.content);
    expect(sentContent.length).toBeLessThan(DIFF.length * 0.9); // RTK rewrote the payload
    expect(sentContent).toContain("added line 0-0");
  });

  it("emits exactly one REQ info line per successful request (R3-1)", async () => {
    const seen = [];
    const { subscribeLog } = await import("../lib/log.mjs");
    const unsub = subscribeLog((text) => { const p = JSON.parse(text); if (p.tag === "REQ") seen.push(p); });
    repos.settings.update({ requireApiKey: false });
    await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    unsub();
    expect(seen).toHaveLength(1);
    expect(seen[0].data.status).toBe("ok");
    expect(seen[0].data.nodeId).toBe(repos.nodes.list()[0].id);
  });

  it("503s with all_unavailable when the only node is disabled (R3-4)", async () => {
    repos.settings.update({ requireApiKey: false });
    repos.nodes.update(repos.nodes.list()[0].id, { enabled: false });
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(503);
    expect(r.body).toContain("all_unavailable");
  });
});

describe("a client walking away is not upstream ill health", () => {
  /** Fire a request, then drop the socket mid-flight. */
  function abortMidFlight(body, afterMs = 300) {
    return new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        () => resolve(),
      );
      req.on("error", () => resolve());
      req.end(payload);
      setTimeout(() => { req.destroy(); resolve(); }, afterMs);
    });
  }

  it("does not count a client abort against the breaker (streaming)", async () => {
    repos.settings.update({ requireApiKey: false });
    const node = repos.nodes.list()[0];
    // upstream sends headers then nothing, so the client's abort is the only event
    stubState.handler = (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); };

    await abortMidFlight({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    await new Promise((r) => setTimeout(r, 400));

    const b = repos.breakers.get(`node:${node.id}`);
    expect(b?.failures ?? 0).toBe(0);
    expect(b?.lastError ?? null).toBeNull();
  }, 15_000);

  it("does not record a client abort during a non-streaming body read as a stall", async () => {
    repos.settings.update({ requireApiKey: false });
    const node = repos.nodes.list()[0];
    stubState.handler = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); };

    await abortMidFlight({ model: "a/m1", stream: false, messages: [{ role: "user", content: "x" }] });
    await new Promise((r) => setTimeout(r, 500));

    const b = repos.breakers.get(`node:${node.id}`);
    // no failure recorded at all — so certainly nothing about a stall
    expect(b?.lastError ?? null).toBeNull();
    expect(b?.failures ?? 0).toBe(0);
  }, 15_000);

  it("still counts a genuine upstream failure", async () => {
    repos.settings.update({ requireApiKey: false });
    const node = repos.nodes.list()[0];
    repos.nodes.update(node.id, { data: { retry: { 404: { attempts: 0 } } } });
    stubState.handler = (req, res) => res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"nope"}}');

    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(503);
    expect(repos.breakers.get(`node:${node.id}`).failures).toBe(1);
  }, 15_000);
});
