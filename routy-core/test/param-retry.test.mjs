// One-shot optional-param retry: the account-scoped param-support gap.
//
// The static STRIP_RULES table (paramSupport.js) can only encode rules true for every account
// of a provider. Some providers disagree with THEMSELVES per account: b.ai's MaaS front rejects
// reasoning_effort values with an opaque 400 ("rejected by an internal MaaS component",
// code 400001 — the body names neither the param nor a reason) on some accounts while the same
// values return 200 on others (live-verified 2026-09-27; the reporting gateway's own node also
// 400'd on values its other accounts accept). A table entry would therefore be wrong somewhere,
// which is the exact mistake #2870bb8 reverted.
//
// The fix is to learn the opinion live: when a request-shaped 400 arrives with an OPAQUE body
// while optional reasoning params are still aboard, retry the same connection once without
// them. Named rejections ("… reasoning_effort medium") do NOT qualify — the caller can fix
// those, and a retry would mask the diagnosis. Nothing is charged to node or key health either
// way; a retry failure falls through to the normal next-route behavior.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { subscribeLog } from "../lib/log.mjs";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubState, node;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "param-retry-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  const handler = createChatHandler(repos);

  stubState = { bodies: [], responses: [] };
  stubPort = await new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        stubState.bodies.push(body);
        const script = stubState.responses.shift();
        if (script?.status) {
          res.writeHead(script.status, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: script.message, type: "invalid_request_error", code: "400001" } }));
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

  node = repos.nodes.create({ name: "bai", prefix: "bai", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
  repos.connections.create({ nodeId: node.id, name: "bai-key", credentials: { apiKey: "sk-test" } });
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

describe("one-shot optional-param retry on an opaque 400", () => {
  it("retries the same connection once without the reasoning params, and the client gets 200", async () => {
    stubState.responses = [
      { status: 400, message: "The request was rejected by an internal MaaS component. Please check the request body." },
    ];
    const lines = [];
    const stop = subscribeLog((text) => lines.push(JSON.parse(text)));
    let r;
    try {
      r = await chat("bai/glm-5.3-flash", { reasoning_effort: "medium" });
    } finally {
      stop();
    }
    expect(r.status).toBe(200);
    expect(stubState.bodies).toHaveLength(2);
    expect(stubState.bodies[0]).toMatchObject({ reasoning_effort: "medium" });
    expect(stubState.bodies[1]).not.toHaveProperty("reasoning_effort");

    const line = lines.find((l) => l.tag === "CHAT" && l.msg.includes("retrying this connection once"));
    expect(line).toBeTruthy();
    expect(line.data.dropped).toEqual({ reasoning_effort: "medium" });
  });

  it("keeps other params on the retry and only drops the reasoning ones", async () => {
    stubState.responses = [
      { status: 400, message: "The request was rejected by an internal MaaS component." },
    ];
    await chat("bai/glm-5.3-flash", { reasoning_effort: "medium", top_p: 0.9 });
    expect(stubState.bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(stubState.bodies[1]).toMatchObject({ top_p: 0.9 });
  });

  it("does not retry when the error body names the rejected param", async () => {
    stubState.responses = [
      { status: 400, message: "MaaS reject: reasoning_effort medium is not accepted" },
    ];
    const r = await chat("bai/glm-5.3-flash", { reasoning_effort: "medium" });
    expect(r.status).toBe(400); // diagnosable — handed to the caller, not masked by a rewrite
    expect(stubState.bodies).toHaveLength(1);
  });

  it("retries once, and surfaces the second 400 to the client", async () => {
    const opaque = "The request was rejected by an internal MaaS component.";
    stubState.responses = [
      { status: 400, message: opaque },
      { status: 400, message: opaque },
    ];
    const r = await chat("bai/glm-5.3-flash", { reasoning_effort: "medium" });
    expect(r.status).toBe(400);
    expect(stubState.bodies).toHaveLength(2);
  });

  it("leaves node and key health untouched by the retry cycle", async () => {
    stubState.responses = [
      { status: 400, message: "The request was rejected by an internal MaaS component." },
    ];
    await chat("bai/glm-5.3-flash", { reasoning_effort: "medium" });
    const breaker = repos.breakers.get(`node:${node.id}`);
    expect(breaker?.failures ?? 0).toBe(0);
    expect(breaker?.openUntil ?? null).toBeNull();
    const conn = repos.connections.list(node.id)[0];
    expect(conn.status).toBe("active");
  });

  it("does not retry a request that carried no optional reasoning params", async () => {
    stubState.responses = [
      { status: 400, message: "The request was rejected by an internal MaaS component." },
    ];
    const r = await chat("bai/glm-5.3-flash");
    expect(r.status).toBe(400);
    expect(stubState.bodies).toHaveLength(1);
  });

  it("the retry budget is per request, not per node lifetime", async () => {
    const opaque = "The request was rejected by an internal MaaS component.";
    stubState.responses = [{ status: 400, message: opaque }]; // first request: retry succeeds (retry sees no script)
    expect((await chat("bai/glm-5.3-flash", { reasoning_effort: "medium" })).status).toBe(200);
    expect(stubState.bodies).toHaveLength(2);
    stubState.responses = [{ status: 400, message: opaque }]; // second request: one-shot resets per request — retry fires again
    const r2 = await chat("bai/glm-5.3-flash", { reasoning_effort: "medium" });
    expect(r2.status).toBe(200); // per-request one-shot, not per-node lifetime
    expect(stubState.bodies).toHaveLength(4);
  });

  // A retry must send a request the caller COULD have sent. On a route that needs translation
  // the body is rebuilt from the source, so dropping the param from the translated body drops it
  // from nothing: the second attempt re-derives the same provider-native thinking field and is
  // byte-identical to the first — a wasted retry that the log reports as a successful drop.
  it("drops the params on a translated route too, where the body is not sent as received", async () => {
    node = repos.nodes.create({ name: "claude", prefix: "anthropic", apiType: "anthropic", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    repos.connections.create({ nodeId: node.id, name: "claude-key", credentials: { apiKey: "sk-claude" } });
    stubState.responses = [
      { status: 400, message: "The request was rejected by an internal MaaS component." },
    ];

    const lines = [];
    const stop = subscribeLog((text) => lines.push(JSON.parse(text)));
    let r;
    try {
      r = await chat("anthropic/claude-3-5-sonnet", { reasoning_effort: "medium", top_p: 0.9 });
    } finally {
      stop();
    }

    expect(r.status).toBe(200);
    expect(stubState.bodies).toHaveLength(2);
    // The upstream speaks Claude, so the retry must not carry the intent in ANY of the shapes
    // translation can produce for it — the first attempt's was `thinking: {budget_tokens: 8192}`.
    for (const key of ["reasoning_effort", "reasoning", "thinking", "budget_tokens", "thinking_budget"]) {
      expect(stubState.bodies[1]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(stubState.bodies[1])).not.toBe(JSON.stringify(stubState.bodies[0]));
    // …and the rest of the request is what translation would have produced without the param
    // (top_p is not the translator's to keep for a Claude target, so it is not asserted here).
    expect(stubState.bodies[1].messages).toEqual(stubState.bodies[0].messages);
    expect(stubState.bodies[1].max_tokens).toBe(stubState.bodies[0].max_tokens);

    const line = lines.find((l) => l.tag === "CHAT" && l.msg.includes("retrying this connection once"));
    expect(line.data.dropped).toEqual({ reasoning_effort: "medium" }); // named as the caller sent it
  });
});
