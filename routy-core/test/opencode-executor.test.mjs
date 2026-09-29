// Preset executors end-to-end against a local stub — loopback only, no live provider, no quota.
// Two behaviors a plausible bug would break:
//  1. opencode composes /zen paths PER MODEL and sends the free-gateway headers
//     (ported from 9router/open-sse/executors/opencode.js);
//  2. a chatUrl preset is posted to the endpoint VERBATIM — routy's default buildUrl appends
//     /chat/completions, which would turn a registry path that already ends in it into a 404.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { probeModel } from "../core/probe.mjs";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubState;

function sseResponse(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`);
  res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        stubState.requests.push({ path: req.url, headers: { ...req.headers }, body: body ? JSON.parse(body) : null });
        sseResponse(res);
      });
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-oce-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  const handler = createChatHandler(repos);
  stubState = { requests: [] };
  stubPort = await startStub();
  handlerPort = await new Promise((resolve) => {
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
  });
  repos.settings.update({ requireApiKey: false });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed by a timed-out test */ }
  handlerServer.closeAllConnections?.();
  stubServer.closeAllConnections?.();
  await new Promise((r) => handlerServer.close(r));
  await new Promise((r) => stubServer.close(r));
});

function addNode({ prefix, baseUrl, data = {}, withConnection = true }) {
  const node = repos.nodes.create({ name: prefix, prefix, apiType: "openai", baseUrl, data });
  if (withConnection) repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "" } });
  return node;
}

function post(model, headers = {}, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }], ...body });
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

const opencodeNode = () => addNode({ prefix: "oc", baseUrl: `http://127.0.0.1:${stubPort}`, data: { executor: "opencode" } });

describe("opencode executor (ported from 9Router's OpenCodeExecutor)", () => {
  it("composes /zen/v1/chat/completions and sends the free-gateway headers", async () => {
    const node = opencodeNode();
    const r = await post("oc/plain-model");
    expect(r.status).toBe(200);
    const seen = stubState.requests[0];
    expect(seen.path).toBe("/zen/v1/chat/completions");
    expect(seen.headers.authorization).toBe("Bearer public");
    expect(seen.headers["x-opencode-client"]).toBe("desktop");
    expect(seen.headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/); // canonical, stable per node
    expect(seen.headers["user-agent"]).toBe("opencode/1.18.31"); // bare "opencode" is a 403 upstream
    expect(seen.body.model).toBe("plain-model");
    expect(seen.body.stream).toBe(true); // zen rejects non-streaming free requests
    // The same node keeps the same session across requests (upstream caches it too).
    await post("oc/another-model");
    expect(stubState.requests[1].headers["x-opencode-session"]).toBe(seen.headers["x-opencode-session"]);
  });

  it("muse-spark models take /zen/v1/responses with the Responses body shape", async () => {
    opencodeNode();
    const r = await post("oc/muse-spark-1.3-contributor-free", {}, { max_tokens: 512, reasoning_effort: "Ultra" });
    expect(r.status).toBe(200);
    const seen = stubState.requests[0];
    expect(seen.path).toBe("/zen/v1/responses");
    expect(seen.body.max_tokens).toBeUndefined();
    expect(seen.body.max_output_tokens).toBe(512);
    // Ultra arrives as xhigh: the openai->responses translator clamps effort to its dialect
    // table before the executor's own pass (which has no clamp — upstream's table is theirs).
    expect(seen.body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(seen.body.reasoning_effort).toBeUndefined();
    expect(seen.body.store).toBe(false); // pooled accounts: no server-side state
    expect(seen.body.stream).toBe(true);
    expect(seen.headers.accept).toBe("text/event-stream");
  });

  it("honours a downstream's canonical session, valid version and project; translates the rest", async () => {
    opencodeNode();
    const canonical = "ses_0123456789abCdefGHIjklmn01"; // 12 hex + 14 base62
    await post("oc/m", { "x-opencode-session": canonical, "x-opencode-project": "proj9", "user-agent": "opencode/1.18.0" });
    let seen = stubState.requests[0];
    expect(seen.headers["x-opencode-session"]).toBe(canonical);
    expect(seen.headers["user-agent"]).toBe("opencode/1.18.0");
    expect(seen.headers["x-opencode-project"]).toBe("proj9");

    // A non-canonical session is hashed into shape, never forwarded raw; bare "opencode"
    // is upgraded to the versioned UA — both raw values are documented 403 bait.
    await post("oc/m", { "x-opencode-session": "ses_client42", "user-agent": "opencode" });
    seen = stubState.requests[1];
    expect(seen.headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(seen.headers["x-opencode-session"]).not.toBe("ses_client42");
    expect(seen.headers["user-agent"]).toBe("opencode/1.18.31");
  });
});

describe("chatUrl presets (the registry endpoint, posted to verbatim)", () => {
  it("posts to data.chatUrl exactly — no /chat/completions appended", async () => {
    addNode({ prefix: "n", baseUrl: `http://127.0.0.1:${stubPort}/v1`, data: { chatUrl: `http://127.0.0.1:${stubPort}/custom/endpoint` } });
    const r = await post("n/m1");
    expect(r.status).toBe(200);
    expect(stubState.requests[0].path).toBe("/custom/endpoint");
  });

  it("a hand-created node without chatUrl keeps the append convention", async () => {
    addNode({ prefix: "n", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    const r = await post("n/m1");
    expect(r.status).toBe(200);
    expect(stubState.requests[0].path).toBe("/v1/chat/completions");
  });
});

// data.noAuth (registry category "free") has NO connections by design — chat runs it through
// pickConnections' anonymous attempt, and probes need no key. This is the whole reason a
// free/no-auth preset is usable at all: without it every path answered no_credentials.
describe("keyless presets (data.noAuth, zero connections)", () => {
  it("serves opencode chat with no connection rows — anonymous attempt, public bearer", async () => {
    addNode({ prefix: "oc", baseUrl: `http://127.0.0.1:${stubPort}`, data: { executor: "opencode", noAuth: true }, withConnection: false });
    const r = await post("oc/plain-model");
    expect(r.status).toBe(200);
    const seen = stubState.requests[0];
    expect(seen.path).toBe("/zen/v1/chat/completions");
    expect(seen.headers.authorization).toBe("Bearer public");
    expect(seen.headers["x-opencode-session"]).toBeTruthy();
  });

  it("serves a chatUrl preset with no connection rows and no auth header at all", async () => {
    addNode({ prefix: "n", baseUrl: `http://127.0.0.1:${stubPort}/v1`, data: { chatUrl: `http://127.0.0.1:${stubPort}/custom/endpoint`, noAuth: true }, withConnection: false });
    const r = await post("n/m1");
    expect(r.status).toBe(200);
    expect(stubState.requests[0].path).toBe("/custom/endpoint");
    expect(stubState.requests[0].headers.authorization).toBeUndefined();
  });

  it("the model probe hits the same endpoint and auth chat sends", async () => {
    const node = addNode({ prefix: "oc", baseUrl: `http://127.0.0.1:${stubPort}`, data: { executor: "opencode", noAuth: true }, withConnection: false });
    const r = await probeModel(node, "muse-spark-1.3-contributor-free", null);
    expect(r.ok, r.error).toBe(true);
    const seen = stubState.requests[0];
    expect(seen.path).toBe("/zen/v1/responses");
    expect(seen.headers.authorization).toBe("Bearer public");
  });

  it("the model probe posts a chatUrl preset to its full endpoint (no append)", async () => {
    const node = addNode({ prefix: "n", baseUrl: `http://127.0.0.1:${stubPort}/v1`, data: { chatUrl: `http://127.0.0.1:${stubPort}/custom/endpoint`, noAuth: true }, withConnection: false });
    const r = await probeModel(node, "m1", null);
    expect(r.ok, r.error).toBe(true);
    expect(stubState.requests[0].path).toBe("/custom/endpoint");
  });
});
