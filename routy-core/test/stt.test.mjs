// Speech-to-text (docs/media-providers.md §8 M3) — multipart in, transcript out.
//
// What is load-bearing: the KIND comes from the path, so the body is never read to discover it,
// and the one field that must change (the model's `<prefix>/`) is changed in a way where the
// header and the bytes always agree. The first test proves the untouched case is byte-identical;
// the second proves a rebuilt body still parses — because a body that parses as a form while its
// boundary header disagrees is the failure this design exists to prevent.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createSttHandler } from "../core/handlers/stt.mjs";
import { createRouter, json } from "../lib/router.mjs";

const AUDIO = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(32, 0x22)]);

let tmp, db, repos, server, port, stubServer, stubPort, stubState;

/** Build a real multipart body the way a client does: append to FormData, let it serialize. */
async function buildForm(fields) {
  const fd = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value instanceof Uint8Array) fd.append(name, new Blob([value]), "clip.mp3");
    else fd.append(name, value);
  }
  const res = new Response(fd);
  const body = Buffer.from(await res.arrayBuffer());
  return { body, contentType: res.headers.get("content-type") };
}

const stt = (p, { body, contentType }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": contentType, "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let parsed = buf.toString("utf8");
          try { parsed = JSON.parse(parsed); } catch { /* text */ }
          resolve({ status: res.statusCode, body: parsed, raw: buf, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-stt-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });

  stubState = { calls: [], responses: [] };
  stubServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const record = { path: req.url, contentType: req.headers["content-type"], raw };
      stubState.calls.push(record);
      // Parse what we received: this is the assertion that header and body still agree.
      try {
        const form = new Response(raw, { headers: { "content-type": req.headers["content-type"] } });
        form.formData().then((fd) => {
          record.form = Object.fromEntries(fd.entries());
        }).catch((err) => { record.formError = String(err?.message || err); }).finally(() => finish());
      } catch (err) {
        record.formError = String(err?.message || err);
        finish();
      }
      const finish = () => {
        const script = stubState.responses.shift() || { status: 200, contentType: "application/json", body: { text: "hello there" } };
        res.writeHead(script.status, { "content-type": script.contentType ?? "application/json" });
        const bytes = Buffer.isBuffer(script.body)
          ? script.body
          : Buffer.from(typeof script.body === "string" ? script.body : JSON.stringify(script.body ?? ""), "utf8");
        res.end(bytes);
      };
    });
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => { stubPort = stubServer.address().port; r(); }));

  const dispatch = createRouter([
    ...buildApiRoutes(repos, { bootstrapToken: "tok" }, "0.1.0"),
    ...buildProxyRoutes(repos, {
      chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }),
      handlers: { stt: createSttHandler(repos, { timeoutMs: 5_000 }) },
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

function sttNode(prefix = "asr", model = "whisper-1", keys = ["sk-asr"]) {
  const node = repos.nodes.create({
    name: prefix, prefix, apiType: "openai",
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    data: { media: { kinds: ["stt"] } },
  });
  keys.forEach((apiKey, i) => repos.connections.create({ nodeId: node.id, name: `${prefix} key ${i + 1}`, credentials: { apiKey } }));
  repos.nodeModels.create({ nodeId: node.id, model, kind: "stt" });
  return node;
}

const firstCall = () => stubState.calls[0];

describe("a multipart body that must not be mangled", () => {
  it("forwards the original bytes and boundary when nothing needs changing", async () => {
    const node = sttNode();
    const { body, contentType } = await buildForm({ model: "whisper-1", language: "en", file: AUDIO });

    const r = await stt("/v1/audio/transcriptions", { body, contentType });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: "hello there" });
    expect(firstCall().raw.equals(body)).toBe(true);      // byte-identical
    expect(firstCall().contentType).toBe(contentType);    // same boundary
    expect(firstCall().form.model).toBe("whisper-1");
    expect(breakerOf(node)).toBe(0);
  });

  it("strips the provider prefix and re-serializes with a boundary that matches", async () => {
    sttNode();
    const { body, contentType } = await buildForm({
      model: "asr/whisper-1", language: "vi", prompt: "say hi", file: AUDIO,
    });

    const r = await stt("/v1/audio/transcriptions", { body, contentType });

    expect(r.status).toBe(200);
    const call = firstCall();
    expect(call.formError).toBeUndefined();               // the pair still parses together
    expect(call.form.model).toBe("whisper-1");            // prefix gone
    expect(call.form.language).toBe("vi");                // every other field survived
    expect(call.form.prompt).toBe("say hi");
    const rebuilt = await new Response(call.raw, { headers: { "content-type": call.contentType } }).formData();
    expect(rebuilt.get("file") instanceof Blob).toBe(true);          // the file part came through
    expect(await rebuilt.get("file").text()).toBe(await new Response(AUDIO).text()); // and intact
    expect(call.contentType).toContain("boundary=");
    expect(call.raw.equals(body)).toBe(false);            // something really was rewritten
  });

  it("takes the model from the query when the form omits it", async () => {
    sttNode();
    const { body, contentType } = await buildForm({ file: AUDIO });
    const r = await stt("/v1/audio/transcriptions?model=asr/whisper-1", { body, contentType });
    expect(r.status).toBe(200);
    expect(firstCall().form.model).toBe("whisper-1");
  });
});

describe("what the gateway refuses", () => {
  it("insists on multipart, on a file, and on a model", async () => {
    sttNode();
    const jsonBody = Buffer.from(JSON.stringify({ model: "asr/whisper-1" }));
    const notMultipart = await stt("/v1/audio/transcriptions", { body: jsonBody, contentType: "application/json" });
    expect(notMultipart.status).toBe(400);
    expect(notMultipart.body.error.detail).toContain("multipart/form-data");

    const noFile = await stt("/v1/audio/transcriptions", { ...(await buildForm({ model: "whisper-1" })) });
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.detail).toContain("file required");

    const noModel = await stt("/v1/audio/transcriptions", { ...(await buildForm({ file: AUDIO })) });
    expect(noModel.status).toBe(400);
    expect(noModel.body.error.detail).toContain("model required");

    expect(stubState.calls).toHaveLength(0); // refused before any provider call
  });

  it("names a wrong kind and refuses a combo", async () => {
    sttNode();
    const other = repos.nodes.create({ name: "chatonly", prefix: "chatonly", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    repos.nodeModels.create({ nodeId: other.id, model: "m1", kind: "llm" });

    const wrong = await stt("/v1/audio/transcriptions", { ...(await buildForm({ model: "chatonly/m1", file: AUDIO })) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.detail).toContain("does not serve speech-to-text");

    repos.combos.create({ name: "stt-combo", models: ["asr/whisper-1"], kind: "stt" });
    const combo = await stt("/v1/audio/transcriptions", { ...(await buildForm({ model: "stt-combo", file: AUDIO })) });
    expect(combo.status).toBe(400);
    expect(combo.body.error.detail).toContain("combos for stt are not enabled yet");
    expect(stubState.calls).toHaveLength(0);
  });

  it("hands a request-shaped rejection to the caller without charging health", async () => {
    const node = sttNode();
    stubState.responses = [{ status: 400, contentType: "application/json", body: { error: { message: "language 'xx' is not supported" } } }];

    const r = await stt("/v1/audio/transcriptions", { ...(await buildForm({ model: "whisper-1", language: "xx", file: AUDIO })) });

    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("upstream_rejected");
    expect(breakerOf(node)).toBe(0);
    expect(r.headers["content-type"]).toContain("application/json"); // the provider's own error, passed back
  });
});

describe("what the response is", () => {
  it("passes the provider's transcript through with its content type", async () => {
    sttNode();
    stubState.responses = [{ status: 200, contentType: "application/json", body: { text: "xin chao", language: "vi", duration: 2.5 } }];
    const r = await stt("/v1/audio/transcriptions", { ...(await buildForm({ model: "whisper-1", file: AUDIO })) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: "xin chao", language: "vi", duration: 2.5 });
  });

  it("records the request under the stt kind and keeps the transcript for the console", async () => {
    const node = sttNode();
    await stt("/v1/audio/transcriptions", { ...(await buildForm({ model: "whisper-1", file: AUDIO })) });
    const ev = repos.usage.query({ limit: 1 })[0];
    expect(ev.kind).toBe("stt");
    expect(ev.status).toBe("ok");
    const details = repos.requestDetails.list({ limit: 5 });
    expect(details.some((d) => d.kind === "response" && JSON.parse(d.content).text)).toBe(true);
    expect(breakerOf(node)).toBe(0);
  });
});

function breakerOf(node) {
  return repos.breakers.get(`node:${node.id}`)?.failures ?? 0;
}
