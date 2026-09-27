// Text-to-speech (docs/media-providers.md §8 M3) — the first kind whose success response is
// not JSON.
//
// What is load-bearing: audio arrives as BYTES, so delivery is an edge decision the provider is
// never asked about twice (`?response_format=json` wraps what the provider sent; anything else
// passes the bytes through), a 200 that carries JSON or text is treated as a provider failure
// rather than served as speech, and a format name a client sends is not a re-encode promise.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createTtsHandler } from "../core/handlers/tts.mjs";
import { createRouter, json } from "../lib/router.mjs";

// ID3-tagged MP3 prefix + padding: the bytes a real speech endpoint sends first.
const AUDIO = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(64, 0x11)]);

let tmp, db, repos, server, port, stubServer, stubPort, stubState;

const post = (p, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let parsed = buf.toString("utf8");
          try { parsed = JSON.parse(parsed); } catch { /* raw bytes */ }
          resolve({ status: res.statusCode, body: parsed, raw: buf, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-tts-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });

  stubState = { calls: [], responses: [] };
  stubServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep raw */ }
      stubState.calls.push({ path: req.url, headers: req.headers, body });
      const script = stubState.responses.shift() || { status: 200, contentType: "audio/mpeg", body: AUDIO };
      res.writeHead(script.status, { "content-type": script.contentType ?? "audio/mpeg" });
      const bytes = Buffer.isBuffer(script.body)
        ? script.body
        : Buffer.from(typeof script.body === "string" ? script.body : JSON.stringify(script.body ?? ""), "utf8");
      res.end(bytes);
    });
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => { stubPort = stubServer.address().port; r(); }));

  const dispatch = createRouter([
    ...buildApiRoutes(repos, { bootstrapToken: "tok" }, "0.1.0"),
    ...buildProxyRoutes(repos, {
      chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }),
      handlers: { tts: createTtsHandler(repos, { timeoutMs: 5_000 }) },
    }),
  ]);
  await new Promise((resolve) => {
    server = http.createServer((req, res) => dispatch(req, res));
    server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
  });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  stubServer?.closeAllConnections?.();
  server?.closeAllConnections?.();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => stubServer?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ttsNode(prefix = "voice", keys = ["sk-voice"]) {
  const node = repos.nodes.create({
    name: prefix, prefix, apiType: "openai",
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    data: { media: { kinds: ["tts"] } },
  });
  keys.forEach((apiKey, i) => repos.connections.create({ nodeId: node.id, name: `${prefix} key ${i + 1}`, credentials: { apiKey } }));
  repos.nodeModels.create({ nodeId: node.id, model: "alloy", kind: "tts" });
  return node;
}

const breaker = (nodeId) => repos.breakers.get(`node:${nodeId}`);

describe("audio as a response", () => {
  it("returns the provider's bytes with its content type", async () => {
    const node = ttsNode();
    const r = await post("/v1/audio/speech", { model: "voice/alloy", input: "hello world" });

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("audio/mpeg");
    expect(r.raw.equals(AUDIO)).toBe(true);
    expect(Number(r.headers["content-length"])).toBe(AUDIO.length);

    // the client's fields reach the provider with only the prefix removed
    expect(stubState.calls[0].body).toEqual({ model: "alloy", input: "hello world" });
    expect(stubState.calls[0].headers.authorization).toBe("Bearer sk-voice");
    expect(breaker(node.id)?.failures ?? 0).toBe(0);
  });

  it("wraps the same bytes in base64 when the client asks for JSON", async () => {
    ttsNode();
    const r = await post("/v1/audio/speech?response_format=json", { model: "voice/alloy", input: "hi" });

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.body.audio).toBe(AUDIO.toString("base64"));
    expect(r.body.format).toBe("mp3"); // audio/mpeg's MIME name, as a file extension
  });

  it("names the provider's real format rather than promising one", async () => {
    ttsNode();
    stubState.responses = [
      { status: 200, contentType: "audio/wav", body: AUDIO },
      { status: 200, contentType: "audio/wav", body: AUDIO },
    ];
    const envelope = await post("/v1/audio/speech?response_format=json", { model: "voice/alloy", input: "hi" });
    expect(envelope.body.format).toBe("wav");                        // from the provider's own type
    expect(envelope.headers["content-type"]).toBe("application/json"); // the envelope is JSON by definition

    const raw = await post("/v1/audio/speech", { model: "voice/alloy", input: "hi" });
    expect(raw.headers["content-type"]).toBe("audio/wav"); // raw path keeps whatever the provider sent
    expect(raw.raw.equals(AUDIO)).toBe(true);
  });

  it("treats a 200 that carries an error as a provider failure, not as speech", async () => {
    const node = ttsNode();
    stubState.responses = [{ status: 200, contentType: "application/json", body: JSON.stringify({ error: { message: "voice is busy" } }) }];

    const r = await post("/v1/audio/speech", { model: "voice/alloy", input: "hi" });
    expect(r.status).toBe(502);
    expect(r.body.error.detail).toContain("instead of audio");
    expect(r.body.error.detail).toContain("voice is busy");
    expect(breaker(node.id).failures).toBe(1); // the provider misbehaved, and the node answers for it
    expect(r.headers["content-type"]).not.toContain("audio"); // nothing audio-shaped was served
  });

  it("treats an empty body as a provider failure", async () => {
    const node = ttsNode();
    stubState.responses = [{ status: 200, contentType: "audio/mpeg", body: Buffer.alloc(0) }];
    const r = await post("/v1/audio/speech", { model: "voice/alloy", input: "hi" });
    expect(r.status).toBe(502);
    expect(r.body.error.detail).toContain("empty");
    expect(breaker(node.id).failures).toBe(1);
  });
});

describe("what the gateway refuses before any provider call", () => {
  it("requires a non-empty input", async () => {
    ttsNode();
    expect((await post("/v1/audio/speech", { model: "voice/alloy" })).body.error.detail).toContain("input");
    expect((await post("/v1/audio/speech", { model: "voice/alloy", input: "   " })).status).toBe(400);
    expect((await post("/v1/audio/speech", { input: "hi" })).body.error.detail).toContain("model");
    expect(stubState.calls).toHaveLength(0);
  });

  it("names a wrong kind and refuses a combo", async () => {
    ttsNode();
    const other = repos.nodes.create({ name: "chatonly", prefix: "chatonly", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    repos.nodeModels.create({ nodeId: other.id, model: "m1", kind: "llm" });
    const wrong = await post("/v1/audio/speech", { model: "chatonly/m1", input: "hi" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.detail).toContain("does not serve text-to-speech");

    repos.combos.create({ name: "tts-combo", models: ["voice/alloy"], kind: "tts" });
    const combo = await post("/v1/audio/speech", { model: "tts-combo", input: "hi" });
    expect(combo.status).toBe(400);
    expect(combo.body.error.detail).toContain("combos for tts are not enabled yet");
    expect(stubState.calls).toHaveLength(0);
  });

  it("records the request under the tts kind", async () => {
    ttsNode();
    await post("/v1/audio/speech", { model: "voice/alloy", input: "hello" });
    const ev = repos.usage.query({ limit: 1 })[0];
    expect(ev.kind).toBe("tts");
    expect(ev.status).toBe("ok");
    const details = repos.requestDetails.list({ limit: 5 });
    expect(details.map((d) => d.kind)).toContain("request");
    expect(details.some((d) => d.kind === "response")).toBe(false); // audio is never stored
  });
});
