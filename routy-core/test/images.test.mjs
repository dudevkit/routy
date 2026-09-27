// Image generation (docs/media-providers.md §8 M2) — the first kind with a response the client
// cannot hold in a variable: bytes, possibly reached through a URL the provider chose.
//
// What is load-bearing:
//   - the three delivery modes (url / b64_json / binary) are an EDGE concern: the provider is
//     asked for what the client needs, and `binary` asks for base64 so the gateway never has
//     to fetch at all when the provider will cooperate;
//   - when it does have to fetch, the URL goes through core/safeFetch.mjs and a refusal is
//     reported as a refusal — never an HTML page wearing an image's content-type;
//   - a provider returning no image data, or bytes that are not an image, is a provider
//     failure the node answers for, not a mystery the client inherits.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createImagesHandler } from "../core/handlers/images.mjs";
import { createRouter, json } from "../lib/router.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const urlImage = { created: 1735000000, data: [{ url: "PLACEHOLDER" }] };
const b64Image = { created: 1735000000, data: [{ b64_json: PNG.toString("base64") }] };

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
          const text = buf.toString("utf8");
          let parsed = text;
          try { parsed = JSON.parse(text); } catch { /* binary or SSE */ }
          resolve({ status: res.statusCode, body: parsed, raw: buf, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-images-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });

  stubState = { calls: [], responses: [] };
  stubServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/asset.png") {           // what a provider's `data[0].url` points at
        stubState.calls.push(req.url);
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      if (req.url === "/page.png") {            // an error page wearing an image's content-type
        stubState.calls.push(req.url);
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.from("<html>rate limited</html>"));
      }
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep raw */ }
      stubState.calls.push(req.url);
      stubState.lastBody = body;
      const script = stubState.responses.shift() || { status: 200, body: urlImage };
      res.writeHead(script.status, { "content-type": "application/json" });
      res.end(JSON.stringify(script.body ?? {}));
    });
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => { stubPort = stubServer.address().port; r(); }));

  const dispatch = createRouter([
    ...buildApiRoutes(repos, { bootstrapToken: "tok" }, "0.1.0"),
    ...buildProxyRoutes(repos, {
      chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }),
      handlers: { images: createImagesHandler(repos, { timeoutMs: 5_000 }) },
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

function imageNode(prefix = "pix", media = { kinds: ["image"] }, keys = ["sk-pix"]) {
  const node = repos.nodes.create({
    name: prefix, prefix, apiType: "openai",
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    data: { media },
  });
  keys.forEach((apiKey, i) => repos.connections.create({ nodeId: node.id, name: `${prefix} key ${i + 1}`, credentials: { apiKey } }));
  repos.nodeModels.create({ nodeId: node.id, model: "img-1", kind: "image" });
  return node;
}

const breaker = (nodeId) => repos.breakers.get(`node:${nodeId}`);

describe("what the client asked to receive", () => {
  it("passes the request through and the provider's answer back untouched", async () => {
    imageNode();
    const r = await post("/v1/images/generations", { model: "pix/img-1", prompt: "a blue square", size: "1024x1024" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject(urlImage);
    expect(stubState.lastBody).toEqual({ model: "img-1", prompt: "a blue square", size: "1024x1024" });
    expect(stubState.lastBody).not.toHaveProperty("response_format"); // nothing injected when the client said nothing
  });

  it("turns an explicit delivery ask into the provider's parameter", async () => {
    imageNode();
    await post("/v1/images/generations?response_format=b64_json", { model: "pix/img-1", prompt: "x" });
    expect(stubState.lastBody.response_format).toBe("b64_json");
  });

  it("returns raw bytes for ?response_format=binary when the provider will send base64", async () => {
    imageNode();
    stubState.responses = [{ status: 200, body: b64Image }];
    const r = await post("/v1/images/generations?response_format=binary", { model: "pix/img-1", prompt: "x" });

    expect(r.status).toBe(200);
    expect(r.raw.equals(PNG)).toBe(true);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["content-disposition"]).toContain('filename="image.png"');
    expect(stubState.lastBody.response_format).toBe("b64_json"); // asked for bytes so no fetch is needed
    expect(stubState.calls.filter((c) => c === "/asset.png")).toHaveLength(0);
  });

  it("fetches the provider's URL when it answers with one, and validates the bytes", async () => {
    imageNode();
    stubState.responses = [{ status: 200, body: { ...urlImage, data: [{ url: `http://127.0.0.1:${stubPort}/asset.png` }] } }];
    const r = await post("/v1/images/generations?response_format=binary", { model: "pix/img-1", prompt: "x" });

    expect(r.status).toBe(200);
    expect(r.raw.equals(PNG)).toBe(true);
    expect(stubState.calls).toContain("/asset.png"); // the gateway really did dereference it
  });
});

describe("what the guard refuses", () => {
  it("refuses a provider URL pointing inside the network, and says why", async () => {
    const node = imageNode();
    stubState.responses = [{ status: 200, body: { ...urlImage, data: [{ url: "http://10.0.0.5/steal" }] } }];

    const r = await post("/v1/images/generations?response_format=binary", { model: "pix/img-1", prompt: "x" });

    expect(r.status).toBe(502);
    expect(r.body.error.message).toBe("image_fetch_failed");
    expect(r.body.error.detail).toContain("10.0.0.5");
    expect(r.body.error.detail).toContain("would not fetch");
    // The provider handed us a URL it should not have — that is its failure, and the node
    // answers for it (the breaker counts it, the keys are untouched).
    expect(breaker(node.id).failures).toBe(1);
  });

  it("refuses a fetched body that is not an image even when it claims to be one", async () => {
    imageNode();
    stubState.responses = [{ status: 200, body: { ...urlImage, data: [{ url: `http://127.0.0.1:${stubPort}/page.png` }] } }];

    const r = await post("/v1/images/generations?response_format=binary", { model: "pix/img-1", prompt: "x" });

    expect(r.status).toBe(502);
    expect(r.body.error.message).toBe("image_fetch_failed");
    expect(r.body.error.detail).toContain("not an image");
  });

  it("refuses base64 that is not an image", async () => {
    imageNode();
    stubState.responses = [{ status: 200, body: { created: 1, data: [{ b64_json: Buffer.from("<html>nope</html>").toString("base64") }] } }];

    const r = await post("/v1/images/generations?response_format=binary", { model: "pix/img-1", prompt: "x" });

    expect(r.status).toBe(502);
    expect(r.body.error.detail).toContain("not an image");
  });
});

describe("what the gateway refuses before any provider call", () => {
  it("requires a prompt and a routable image model", async () => {
    imageNode();
    expect((await post("/v1/images/generations", { model: "pix/img-1" })).body.error.detail).toContain("prompt required");
    expect((await post("/v1/images/generations", { model: "ghost/img-1", prompt: "x" })).body.error.detail).toContain("not routable");
    expect(stubState.calls).toHaveLength(0);

    const other = repos.nodes.create({ name: "chatonly", prefix: "chatonly", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    repos.nodeModels.create({ nodeId: other.id, model: "m1", kind: "llm" });
    const wrong = await post("/v1/images/generations", { model: "chatonly/m1", prompt: "x" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.detail).toContain("does not serve images");
  });

  it("refuses an unknown delivery mode and a combo", async () => {
    imageNode();
    const bad = await post("/v1/images/generations?response_format=animated", { model: "pix/img-1", prompt: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.detail).toContain("response_format must be one of");

    repos.combos.create({ name: "img-combo", models: ["pix/img-1"], kind: "image" });
    const combo = await post("/v1/images/generations", { model: "img-combo", prompt: "x" });
    expect(combo.status).toBe(400);
    expect(combo.body.error.detail).toContain("combos for images are not enabled yet");
    expect(stubState.calls).toHaveLength(0);
  });

  it("reports a provider that answers with no image data as a provider failure", async () => {
    const node = imageNode();
    stubState.responses = [{ status: 200, body: { created: 1, data: [] } }];

    const r = await post("/v1/images/generations", { model: "pix/img-1", prompt: "x" });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toBe("all_keys_failed");
    expect(r.body.error.detail).toContain("no image data");
    expect(breaker(node.id).failures).toBe(1);
  });
});
