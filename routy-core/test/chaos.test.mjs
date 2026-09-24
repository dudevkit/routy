// P3 chaos gate — the failure modes that must not corrupt state or hang a client:
// upstream dies mid-stream, client vanishes mid-stream, breaker survives a
// restart, concurrent load stays isolated, and buffers stay bounded.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler, recordFailure } from "../core/handlers/chat.mjs";
import { isTerminalFrame, LogBuffer } from "../core/sse/stream.mjs";

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
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function boot() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-chaos-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  const handler = createChatHandler(repos);

  stubState = { requests: [], handler: (req, res, n) => sseResponse(res, `resp-${n}`) };
  stubPort = await startStub();

  handlerPort = await new Promise((resolve) => {
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
  });

  const node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
  repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "k-a" } });
  repos.settings.update({ requireApiKey: false });
  return node;
}

async function teardown() {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  handlerServer?.closeAllConnections?.();
  stubServer?.closeAllConnections?.();
  await new Promise((r) => handlerServer?.close(r));
  await new Promise((r) => stubServer?.close(r));
}

beforeEach(boot);
afterEach(teardown);

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("chaos: upstream dies mid-stream", () => {
  it("terminates the client with an error frame and marks the node down", async () => {
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"before-crash"},"finish_reason":null}]}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20); // hard kill, no [DONE]
    };

    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(200); // headers already sent — the failure is in-band
    expect(r.body).toContain("before-crash");
    expect(r.body).toContain("upstream_stream_failed");

    const node = repos.nodes.list()[0];
    const b = repos.breakers.get(`node:${node.id}`);
    expect(b.failures).toBe(1);
    repos.usage.flush();
    expect(repos.usage.query({ limit: 10 })).toHaveLength(1);
  }, 10_000);

  it("trips the breaker after 3 consecutive mid-stream deaths (headers are not success)", async () => {
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20);
    };
    const node = repos.nodes.list()[0];
    for (let i = 0; i < 3; i++) {
      await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    }
    const b = repos.breakers.get(`node:${node.id}`);
    expect(b.failures).toBe(3);
    expect(b.state).toBe("open");

    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(503);
    expect(r.body).toContain("all_unavailable");
  }, 15_000);

  it("stays usable afterwards — a healthy retry succeeds", async () => {
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20);
    };
    await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });

    stubState.handler = (req, res, n) => sseResponse(res, `recovered-${n}`);
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(200);
    expect(r.body).toContain("recovered-");
    expect(r.body.trim().endsWith("data: [DONE]")).toBe(true);
    expect(repos.breakers.get(`node:${repos.nodes.list()[0].id}`).failures).toBe(0);
  }, 10_000);
});

/** Poll a bounded window rather than sleeping a fixed interval: the proxy notices the
 * walk-away asynchronously, and a hard-coded 300ms is exactly how this test flakes when
 * the suite runs several workers on a loaded machine. */
async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("chaos: client vanishes mid-stream", () => {
  it("aborts the upstream and records the request as aborted", async () => {
    let upstreamClosed = false;
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        if (res.writableEnded) return clearInterval(tick);
        res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${n++}"},"finish_reason":null}]}\n\n`);
      }, 20);
      res.on("close", () => { upstreamClosed = true; clearInterval(tick); });
    };

    // raw socket so we can walk away mid-stream
    await new Promise((resolve) => {
      const payload = JSON.stringify({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
      const req = http.request(
        { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          res.once("data", () => { req.destroy(); resolve(); });
        },
      );
      req.end(payload);
    });

    await until(() => upstreamClosed);
    expect(upstreamClosed).toBe(true); // proxy stopped pulling from upstream

    // The usage event lands when the pump unwinds, a beat after the socket closes.
    const events = (await until(() => {
      repos.usage.flush();
      const rows = repos.usage.query({ limit: 10 });
      return rows.length ? rows : null;
    })) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("aborted");
  }, 10_000);
});

describe("chaos: breaker survives a restart", () => {
  it("keeps a tripped node down across process restart", async () => {
    const node = repos.nodes.list()[0];
    repos.nodes.update(node.id, { data: { retry: { 503: { attempts: 0 } } } });
    stubState.handler = (req, res) => res.writeHead(503).end("down");
    for (let i = 0; i < 3; i++) await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(repos.breakers.get(`node:${node.id}`).state).toBe("open");

    await new Promise((r) => setTimeout(r, 50)); // debounced persist tick
    repos.close();
    db.close();
    handlerServer.closeAllConnections?.();
    await new Promise((r) => handlerServer.close(r));

    // "restart": reopen the same data dir
    db = openDatabase(tmp);
    repos = createRepos(db);
    const handler = createChatHandler(repos);
    handlerPort = await new Promise((resolve) => {
      handlerServer = http.createServer((req, res) => handler(req, res));
      handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
    });

    const restored = repos.breakers.get(`node:${node.id}`);
    expect(restored.state).toBe("open");
    expect(Date.parse(restored.openUntil)).toBeGreaterThan(Date.now());

    // still refusing to hammer the dead upstream
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(503);
    expect(r.body).toContain("all_unavailable");
  }, 15_000);
});

describe("chaos: concurrent load", () => {
  it("keeps 20 parallel streams isolated with exact usage rows", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post({ model: "a/m1", stream: true, messages: [{ role: "user", content: `req-${i}` }] })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const contents = results.map((r) => r.body.match(/"content":"(resp-\d+)"/)?.[1]);
    expect(contents.every(Boolean)).toBe(true);
    expect(new Set(contents).size).toBe(20); // no cross-talk between streams
    expect(results.every((r) => r.body.trim().endsWith("data: [DONE]"))).toBe(true);

    repos.usage.flush();
    const events = repos.usage.query({ limit: 100 });
    expect(events).toHaveLength(20);
    expect(events.every((e) => e.status === "ok")).toBe(true);
    expect(repos.usage.query({ limit: 100 }).reduce((s, e) => s + e.completion_tokens, 0)).toBe(20);
  }, 20_000);
});

describe("chaos: bounded buffers", () => {
  it("LogBuffer stops retaining past its cap but keeps counting", () => {
    const lb = new LogBuffer({ capBytes: 100 });
    for (let i = 0; i < 50; i++) lb.append("x".repeat(20)); // 1000 bytes offered
    expect(Buffer.byteLength(lb.text, "utf8")).toBeLessThanOrEqual(100);
    expect(lb.total).toBe(1000);
    expect(lb.truncated).toBe(true);
  });

  it("a 2MB stream through the proxy does not accumulate in the response buffer", async () => {
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 40k chunks x ~60 bytes ≈ 2.4MB of SSE
      for (let i = 0; i < 40_000; i++) {
        res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${"a".repeat(40)}"},"finish_reason":null}]}\n\n`);
      }
      res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":40000}}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    };

    const before = process.memoryUsage().heapUsed;
    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

    expect(r.status).toBe(200);
    expect(r.body.trim().endsWith("data: [DONE]")).toBe(true);
    expect(r.body.length).toBeGreaterThan(2_000_000); // the client really did receive it all
    expect(growthMb).toBeLessThan(50); // retained detail is capped; nothing buffers the whole stream

    const detail = repos.requestDetails.list({ limit: 10 })[0];
    if (detail) expect(detail.content.length).toBeLessThanOrEqual(64 * 1024 + 200);
  }, 30_000);
});

// The Hermes shape, and the case that was being mislabelled. The provider is still
// holding its SSE open; the client sees finish_reason / [DONE] and closes the socket
// immediately. Routy delivered the entire answer, but `clientGone` was the only signal,
// so the request was charged as an abort: the node never got breaker credit, its
// latency was never learned (chat.mjs gates observeTtft on status === "ok"), and every
// such call landed in Recent failures. 30 of 32 requests on a real server read that way.
describe("chaos: client hangs up the moment the answer is complete", () => {
  it("records ok and credits the breaker when the client leaves after the terminal frame", async () => {
    const node = repos.nodes.list()[0];
    // Start from a damaged breaker: a bare `failures === 0` assertion would pass even
    // if recordSuccess were never called, which is the bug being tested.
    recordFailure(repos, node, { errorCode: "upstream_error", status: 502, message: "earlier problem" });
    recordFailure(repos, node, { errorCode: "upstream_error", status: 502, message: "earlier problem" });
    expect(repos.breakers.get(`node:${node.id}`).failures).toBe(2);

    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      // deliberately NOT res.end(): a real upstream often keeps the socket open, and
      // that gap is exactly where the client hangup lands.
    };

    await new Promise((resolve) => {
      const payload = JSON.stringify({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
      const req = http.request(
        { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          let seen = "";
          res.on("data", (c) => {
            seen += c;
            if (seen.includes("[DONE]")) {
              req.destroy(); // walk away as soon as the answer is complete
              resolve();
            }
          });
        },
      );
      req.on("error", () => { /* our own destroy */ });
      req.end(payload);
    });

    const events = (await until(() => {
      repos.usage.flush();
      const rows = repos.usage.query({ limit: 10 });
      return rows.length ? rows : null;
    })) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("ok");
    // credit, not merely "not open": the failure count has to go back to zero
    const breaker = repos.breakers.get(`node:${node.id}`);
    expect(breaker.failures).toBe(0);
    expect(breaker.state).toBe("closed");
    expect(breaker.lastError).toBeNull();
  }, 10_000);
});

describe("terminal frame detection", () => {
  it("recognises both dialects and their terminal markers", () => {
    expect(isTerminalFrame('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')).toBe(true);
    expect(isTerminalFrame("data: [DONE]\n\n")).toBe(true);
    expect(isTerminalFrame('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n')).toBe(true);
    expect(isTerminalFrame('data: {"type":"message_stop"}\n\n')).toBe(true);
    // not terminal: a content delta, an event-only frame, a non-JSON line
    expect(isTerminalFrame('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n')).toBe(false);
    expect(isTerminalFrame("event: ping\ndata: {\"type\":\"ping\"}\n\n")).toBe(false);
    expect(isTerminalFrame("data: \n\n")).toBe(false);
    expect(isTerminalFrame("")).toBe(false);
  });
});
