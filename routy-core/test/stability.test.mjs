// P3 stability — breaker backoff ladder, half-open re-open, stream stall
// watchdog, non-streaming stall, and retention purge.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler, recordFailure } from "../core/handlers/chat.mjs";

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

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-stab-"));
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

describe("breaker backoff (half-open probing)", () => {
  it("lengthens the open window on each consecutive failure, capped at 30min", () => {
    const node = { id: "n1" };
    const windows = [];
    for (let i = 0; i < 8; i++) {
      const before = Date.now();
      recordFailure(repos, node, { errorCode: "upstream_error", message: "boom" });
      const b = repos.breakers.get("node:n1");
      if (b.state === "open") windows.push(Math.round((Date.parse(b.openUntil) - before) / 1000));
    }
    // failures 1,2 stay closed; 3..8 open for 60,120,240,480,960,1800(cap)
    const expected = [60, 120, 240, 480, 960, 1800];
    expect(windows).toHaveLength(expected.length);
    windows.forEach((w, i) => expect(Math.abs(w - expected[i])).toBeLessThanOrEqual(2));
  });

  it("re-opens with a doubled window when a half-open probe fails", () => {
    const node = { id: "n2" };
    for (let i = 0; i < 3; i++) recordFailure(repos, node, { errorCode: "upstream_error", message: "x" });
    const first = repos.breakers.get("node:n2");
    expect(first.state).toBe("open");
    const firstMs = Date.parse(first.openUntil) - Date.now();

    // simulate the window expiring: the next request is the half-open probe
    repos.breakers.record("node:n2", { openUntil: new Date(Date.now() - 1).toISOString() });
    const before = Date.now();
    recordFailure(repos, node, { errorCode: "upstream_error", message: "still down" });
    const second = repos.breakers.get("node:n2");
    const secondMs = Date.parse(second.openUntil) - before;

    expect(secondMs).toBeGreaterThan(firstMs * 1.5);
    expect(secondMs).toBeLessThan(firstMs * 2.5);
  });

  it("clears the failure count after a successful request", async () => {
    repos.settings.update({ requireApiKey: false });
    const node = repos.nodes.list()[0];
    repos.nodes.update(node.id, { data: { retry: { 503: { attempts: 0 } } } });
    stubState.handler = (req, res) => res.writeHead(503).end("down");
    await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(repos.breakers.get(`node:${node.id}`).failures).toBe(2);

    stubState.handler = (req, res) => sseResponse(res);
    await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    const b = repos.breakers.get(`node:${node.id}`);
    expect(b.state).toBe("closed");
    expect(b.failures).toBe(0); // a recovered node restarts the ladder at the base window
  });
});

describe("stream stall watchdog", () => {
  it("aborts a silent stream and emits a terminal error frame", async () => {
    repos.settings.update({ requireApiKey: false });
    const node = repos.nodes.list()[0];
    repos.nodes.update(node.id, { data: { streamIdleTimeoutMs: 200 } });
    // upstream sends one chunk, then goes silent without closing
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n`);
    };

    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(200);
    expect(r.body).toContain("partial");
    expect(r.body).toContain("upstream_stalled");

    const b = repos.breakers.get(`node:${node.id}`);
    expect(b.failures).toBe(1);
    expect(b.lastError).toContain("upstream_stalled");

    repos.usage.flush();
    expect(repos.usage.query({ limit: 1 })[0].status).toBe("error");
  }, 10_000);

  it("aborts a stalled non-streaming body instead of hanging", async () => {
    repos.settings.update({ requireApiKey: false });
    const node = repos.nodes.list()[0];
    repos.nodes.update(node.id, { data: { streamIdleTimeoutMs: 200 } });
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders(); // headers must land, body must not — that's the stall
    };

    const r = await post({ model: "a/m1", stream: false, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(503);
    expect(r.body).toContain("upstream_stalled");
    expect(repos.breakers.get(`node:${node.id}`).failures).toBe(1);
  }, 10_000);

  it("leaves a healthy stream untouched (watchdog is not a deadline)", async () => {
    repos.settings.update({ requireApiKey: false });
    repos.nodes.update(repos.nodes.list()[0].id, { data: { streamIdleTimeoutMs: 200 } });
    stubState.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${n}"},"finish_reason":null}]}\n\n`);
        if (++n === 4) {
          clearInterval(tick);
          res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 100);
    };

    const r = await post({ model: "a/m1", stream: true, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(200);
    expect(r.body).toContain("[DONE]");
    expect(r.body).not.toContain("upstream_stalled");
    expect(repos.breakers.get(`node:${repos.nodes.list()[0].id}`).failures ?? 0).toBe(0);
  }, 10_000);
});

describe("retention", () => {
  it("purges aged usage events and trims to the row cap", () => {
    repos.usage.record({ ts: Date.now() - 200 * 24 * 3600 * 1000, model: "old", status: "ok" });
    repos.usage.record({ ts: Date.now() - 10, model: "mid", status: "ok" });
    repos.usage.record({ ts: Date.now(), model: "new", status: "ok" });

    const aged = repos.usage.purge({ maxAgeDays: 90, maxRows: 500_000 });
    expect(aged.aged).toBe(1);
    expect(repos.usage.query({ limit: 10 }).map((e) => e.model)).toEqual(["new", "mid"]);

    const capped = repos.usage.purge({ maxAgeDays: 3650, maxRows: 1 });
    expect(capped.capped).toBe(1);
    expect(repos.usage.query({ limit: 10 }).map((e) => e.model)).toEqual(["new"]);
  });

  it("purges aged request details", async () => {
    repos.requestDetails.save({ kind: "request", content: { body: { a: 1 } } });
    await new Promise((r) => setTimeout(r, 5)); // ensure the row's ts is behind the cutoff
    const purged = repos.requestDetails.purge({ maxAgeDays: 0, maxRows: 50000 });
    expect(purged.aged).toBe(1);
  });
});

// The single-gateway lock. One routy.db implies one gateway, and the two halves of
// that rule live in files that cannot import each other: server.mjs decides the exit
// code, bin/launch.mjs decides whether to retry it. If they drift, a clear conflict
// turns back into an eight-attempt backoff loop.
describe("single-gateway lock", () => {
  it("exits with LOCK_HELD rather than a crash code when another gateway owns the db", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "routy-lock-"));
    // Our own pid is alive, so this reads as a running gateway holding the lock.
    fs.writeFileSync(
      path.join(home, "gateway.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [path.resolve("server.mjs")], {
      cwd: path.resolve("."),
      env: { ...process.env, ROUTY_HOME: home, ROUTY_PORT: "8099" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    const code = await new Promise((resolve) => child.on("exit", resolve));

    expect(code).toBe(73); // LOCK_HELD — must match bin/launch.mjs
    expect(err).toContain("already running");
    // it names the holder and how to stop it, so the operator is not left guessing
    expect(err).toContain(String(process.pid));

    fs.rmSync(home, { recursive: true, force: true });
  }, 30_000);
});
