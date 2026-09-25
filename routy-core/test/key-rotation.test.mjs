// Rotation end to end through the real chat handler: two keys on one node, a stub
// upstream that fails per key, and assertions on what the client receives and what the
// health store ends up saying. This is the user-visible contract of key rotation:
// round-robin spreads requests, a dead key rotates to the next one transparently, and a
// provider-wide 429 reaches the client as upstream_rate_limited instead of torching
// every key.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { connectionState } from "../core/key-health.mjs";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubState;
let keyA, keyB;

const chat = (stream = true) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: "a/m1", stream, messages: [{ role: "user", content: "x" }] });
    const req = http.request(
      { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "key-rotation-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  const handler = createChatHandler(repos);

  stubPort = await new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // The key travels in the Authorization header, not the body — a stub that
        // greps the body cannot tell which key it is serving, and would silently test
        // nothing.
        stubState.requests.push({ auth: req.headers.authorization || "", body });
        stubState.handler(req, res, body);
      });
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });

  handlerPort = await new Promise((resolve) => {
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
  });

  const node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
  keyA = repos.connections.create({ nodeId: node.id, name: "k1", credentials: { apiKey: "sk-aaa" } });
  keyB = repos.connections.create({ nodeId: node.id, name: "k2", credentials: { apiKey: "sk-bbb" } });
  repos.settings.update({ requireApiKey: false });
  stubState = { requests: [], handler: () => {} };
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  handlerServer?.closeAllConnections?.();
  stubServer?.closeAllConnections?.();
  await new Promise((r) => handlerServer?.close(r));
  await new Promise((r) => stubServer?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sse = (res, content) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};
const whichKey = (auth) => (String(auth).includes("sk-aaa") ? keyA.id : String(auth).includes("sk-bbb") ? keyB.id : null);
const lastAuth = () => stubState.requests.at(-1)?.auth;

describe("key rotation through the chat handler", () => {
  it("rotates per request across healthy keys", async () => {
    stubState.handler = (req, res) => sse(res, "hi");
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const r = await chat();
      expect(r.status).toBe(200);
      seen.push(whichKey(lastAuth()));
    }
    // 2 keys, 4 requests: the load is spread, not pinned to one key
    expect(seen.filter((k) => k === keyA.id)).toHaveLength(2);
    expect(seen.filter((k) => k === keyB.id)).toHaveLength(2);
  }, 15_000);

  it("falls through a broken key to the healthy one in the same request", async () => {
    stubState.handler = (req, res) => {
      if (whichKey(req.headers.authorization) === keyA.id) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      }
      sse(res, "from-b");
    };
    const r = await chat();
    expect(r.status).toBe(200);
    expect(r.body).toContain("from-b");
    // the broken key is on strike 1, not yet disabled; the healthy one is clean
    expect(connectionState(repos, keyA.id).failures).toBe(1);
    expect(repos.connections.get(keyA.id).status).toBe("active");
    expect(connectionState(repos, keyB.id).state).toBe("closed");
  }, 15_000);

  it("disables a key after a second hard failure and then skips it", async () => {
    stubState.handler = (req, res) => {
      if (whichKey(req.headers.authorization) === keyA.id) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      }
      sse(res, "ok");
    };
    // rotation alternates, so the bad key meets two requests on the 1st and 3rd
    await chat();
    expect(repos.connections.get(keyA.id).status).toBe("active");
    await chat();
    await chat();
    expect(repos.connections.get(keyA.id).status).toBe("disabled");
    // and it is out of rotation: the next request cannot reach it
    const before = stubState.requests.length;
    const r = await chat();
    expect(r.status).toBe(200);
    expect(whichKey(stubState.requests.at(-1).auth)).toBe(keyB.id);
    expect(stubState.requests.length).toBe(before + 1); // one attempt, no wasted probe
  }, 15_000);

  it("reports a provider-wide 429 body as upstream_rate_limited, touching no key", async () => {
    stubState.handler = (req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      res.end(JSON.stringify({ error: { message: "rate limited by upstream, try again later" } }));
    };
    const r = await chat();
    expect(r.status).toBe(429);
    const err = JSON.parse(r.body).error;
    expect(err.message).toBe("upstream_rate_limited");
    expect(err.detail).toContain("pick another upstream or model");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    // the whole point: a problem no key can fix must not cost keys
    expect(connectionState(repos, keyA.id).state).not.toBe("cooldown");
    expect(connectionState(repos, keyB.id).state).not.toBe("cooldown");
    // and the saturation is remembered, so the next request does not re-probe the wall
    const attempts = stubState.requests.length;
    const r2 = await chat();
    expect(r2.status).toBe(429);
    expect(JSON.parse(r2.body).error.message).toBe("upstream_rate_limited");
    expect(stubState.requests.length).toBe(attempts);
  }, 15_000);

  it("flips to provider-wide on behavior when the body is ambiguous, undoing the cooldown", async () => {
    // Body matches neither the per-key nor the provider-wide patterns: the first key
    // cools on a guess, the second distinct 429 is what proves it was never the keys.
    stubState.handler = (req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "slow down" } }));
    };
    const r = await chat();
    expect(r.status).toBe(429);
    expect(JSON.parse(r.body).error.message).toBe("upstream_rate_limited");
    // the guess that cooled key A has been rolled back — a wrong cooldown is a bug
    expect(connectionState(repos, keyA.id).state).not.toBe("cooldown");
  }, 15_000);

  it("returns all_keys_exhausted with the soonest recovery when every key is cooling", async () => {
    stubState.handler = (req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "your api key has exceeded its per-key rate limit" } }));
    };
    const r = await chat();
    // both keys are per-key throttled: rotation tried each, both cooled, none left
    expect(r.status).toBe(503);
    const err = JSON.parse(r.body).error;
    expect(err.message).toBe("all_keys_exhausted");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(connectionState(repos, keyA.id).state).toBe("cooldown");
    expect(connectionState(repos, keyB.id).state).toBe("cooldown");
  }, 15_000);
});
