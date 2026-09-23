// P1.4 executor tests — hermetic stub upstream; retries, timeouts, auth, errors.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { DefaultExecutor } from "../core/executors/default.mjs";

let server;
let port;
let state; // per-test behavior hooks

function startStub() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        state.requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        state.handler(req, res, state.requests.length);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

beforeEach(async () => {
  state = { requests: [], handler: (req, res) => sse(res) };
  port = await startStub();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

function makeExecutor(nodeOverrides = {}, connOverrides = {}) {
  const node = { id: "n1", prefix: "test", apiType: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, data: nodeOverrides.data || null };
  const connection = { credentials: { apiKey: "secret-key" }, ...connOverrides };
  return new DefaultExecutor(node, connection);
}

const BODY = { messages: [{ role: "user", content: "hi" }] };

describe("DefaultExecutor", () => {
  it("sends auth + model + stream, returns streaming response", async () => {
    const ex = makeExecutor();
    const result = await ex.execute({ model: "m1", body: BODY, stream: true });
    expect(result.ok).toBe(true);
    expect(state.requests[0].auth).toBe("Bearer secret-key");
    expect(state.requests[0].body.model).toBe("m1");
    expect(state.requests[0].body.stream).toBe(true);
    const text = await result.response.text();
    expect(text).toContain("[DONE]");
  });

  it("retries 502 per config then succeeds", async () => {
    state.handler = (req, res, n) => (n <= 2 ? res.writeHead(502).end("bad gw") : sse(res));
    const ex = makeExecutor({ data: { retry: { 502: { attempts: 3, delayMs: 10 } } } });
    const t0 = Date.now();
    const result = await ex.execute({ model: "m1", body: BODY, stream: true });
    expect(result.ok).toBe(true);
    expect(state.requests.length).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20); // 2 delays of 10ms
  });

  it("does not retry 429 by default and surfaces Retry-After", async () => {
    state.handler = (req, res) => {
      res.writeHead(429, { "retry-after": "2" });
      res.end("rate limited");
    };
    const ex = makeExecutor();
    const result = await ex.execute({ model: "m1", body: BODY, stream: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.errorCode).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(2000);
    expect(state.requests.length).toBe(1);
  });

  it("classifies 401 as auth_error without retry", async () => {
    state.handler = (req, res) => res.writeHead(401).end("nope");
    const result = await makeExecutor().execute({ model: "m1", body: BODY, stream: true });
    expect(result.errorCode).toBe("auth_error");
    expect(state.requests.length).toBe(1);
  });

  it("aborts on connect timeout and reports connect_timeout", async () => {
    state.handler = () => { /* never respond */ };
    const ex = makeExecutor({ data: { timeoutMs: 150 } });
    const result = await ex.execute({ model: "m1", body: BODY, stream: true });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("connect_timeout");
  });
  it("propagates client abort", async () => {
    state.handler = () => { /* never respond — abort fires before headers */ };
    const ac = new AbortController();
    const p = makeExecutor().execute({ model: "m1", body: BODY, stream: true, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const result = await p;
    expect(result.errorCode).toBe("client_aborted");
  });

  it("builds /responses url for responses apiType", async () => {
    const ex = makeExecutor();
    ex.node = { ...ex.node, apiType: "responses" };
    expect(ex.buildUrl()).toBe(`http://127.0.0.1:${port}/v1/responses`);
    expect(ex.buildUrl.call({ node: { ...ex.node, apiType: "openai" } })).toBe(`http://127.0.0.1:${port}/v1/chat/completions`);
  });
});
