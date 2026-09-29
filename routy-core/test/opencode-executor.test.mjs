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

function addNode({ prefix, baseUrl, data = {} }) {
  const node = repos.nodes.create({ name: prefix, prefix, apiType: "openai", baseUrl, data });
  repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "" } });
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
    expect(seen.headers["x-opencode-session"]).toBe(`ses_${node.id}`); // stable per node
    expect(seen.headers["user-agent"]).toBe("opencode");
    expect(seen.body.model).toBe("plain-model");
  });

  it("muse-spark models take /zen/v1/responses with the Responses body shape", async () => {
    opencodeNode();
    const r = await post("oc/muse-spark-1.3-contributor-free", {}, { max_tokens: 512, reasoning_effort: "Ultra" });
    expect(r.status).toBe(200);
    const seen = stubState.requests[0];
    expect(seen.path).toBe("/zen/v1/responses");
    expect(seen.body.max_tokens).toBeUndefined();
    expect(seen.body.max_output_tokens).toBe(512);
    expect(seen.body.reasoning).toEqual({ effort: "ultra", summary: "auto" });
    expect(seen.body.reasoning_effort).toBeUndefined();
    expect(seen.headers.accept).toBe("text/event-stream");
  });

  it("forwards the downstream client's own session, project and UA when it is opencode", async () => {
    opencodeNode();
    await post("oc/m", { "x-opencode-session": "ses_client42", "x-opencode-project": "proj9", "user-agent": "opencode/1.2" });
    const seen = stubState.requests[0];
    expect(seen.headers["x-opencode-session"]).toBe("ses_client42");
    expect(seen.headers["x-opencode-project"]).toBe("proj9");
    expect(seen.headers["user-agent"]).toBe("opencode/1.2");
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
