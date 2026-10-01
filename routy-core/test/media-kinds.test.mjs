// Media kinds (docs/media-providers.md §0/§8 M0) — the foundation every media phase rests on.
//
// Three things are load-bearing and each is pinned here:
//   1. "kind" is what keeps an endpoint and a model in step — a model is reachable only from
//      the endpoint matching its kind, and kind is decided by the PATH, never by the body.
//   2. Chat discovery is bit-for-bit unchanged. It is the list every connected client already
//      reads, and a media model appearing in it would be a 400 from a provider, not a feature.
//   3. A media config is validated where it is authored (the API), because a typo'd kind that
//      sits on a node looking applied is worse than a rejected request.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createRouter, json } from "../lib/router.mjs";
import { listModels, modelInfo, resolveRoute } from "../core/routing.mjs";
import { MEDIA_KINDS, MEDIA_KIND_IDS, AUTH_STYLES, validateMediaConfig } from "../core/media.mjs";

let tmp, db, repos, server, port, cfg;

const request = (method, p, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
const get = (p) => request("GET", p);
const post = (p, body) => request("POST", p, body);
const put = (p, body) => request("PUT", p, body);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-media-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });
  cfg = { bootstrapToken: "tok" };
  // The chat routes are stubbed: this file covers routing/discovery, and chat has its own suite.
  const dispatch = createRouter([
    ...buildApiRoutes(repos, cfg, "0.1.0"),
    ...buildProxyRoutes(repos, { chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }) }),
  ]);
  await new Promise((resolve) => {
    server = http.createServer((req, res) => dispatch(req, res));
    server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
  });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  server?.closeAllConnections?.();
  await new Promise((r) => server?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A node, with its media declaration as the API would store it. */
const node = (prefix, media, extra = {}) =>
  repos.nodes.create({ name: prefix, prefix, apiType: "openai", baseUrl: `http://127.0.0.1:1/v1`, data: { ...(media ? { media } : {}), ...extra } });

describe("the kind enum", () => {
  it("keeps every kind pointed at its own endpoint", () => {
    expect(MEDIA_KIND_IDS).toEqual(["embedding", "image", "tts", "webSearch", "webFetch", "systemone"]);
    const paths = MEDIA_KIND_IDS.map((k) => MEDIA_KINDS[k].path);
    expect(new Set(paths).size).toBe(paths.length); // a path serves exactly one kind
    for (const kind of MEDIA_KIND_IDS) {
      expect(MEDIA_KINDS[kind].path).toMatch(/^\/v1\//);
      expect(["node", "voices", "none"]).toContain(MEDIA_KINDS[kind].modelList);
      expect(typeof MEDIA_KINDS[kind].label).toBe("string");
    }
    expect(MEDIA_KINDS.tts.path).toBe("/v1/audio/speech");
  });
});

describe("validating a media config where it is authored", () => {
  it("accepts the shape the API stores", () => {
    const ok = validateMediaConfig({
      kinds: ["image", "embedding", "image"],
      urls: { image: "https://api.example.com/v1/images/generations" },
      auth: { image: { style: "x-api-key" } },
      noAuth: false,
    });
    expect(ok.ok).toBe(true);
    expect(ok.value.kinds).toEqual(["image", "embedding"]); // deduped, order kept
    expect(ok.value.urls.image).toContain("/images/generations");
  });

  it("treats null as 'no media, chat only'", () => {
    expect(validateMediaConfig(null)).toEqual({ ok: true, value: null });
    expect(validateMediaConfig(undefined)).toEqual({ ok: true, value: null });
  });

  it("refuses what would silently do nothing", () => {
    const bad = [
      [{ kinds: ["images"] }, /not a kind/],                       // typo'd kind
      [{ url: "https://x.test" }, /not a setting/],                 // `url` for `urls`
      [{ kinds: "image" }, /must be an array/],
      [{ urls: { image: "ftp://x.test/a" } }, /must be http\(s\)/],
      [{ urls: { image: "not a url" } }, /not a valid URL/],
      [{ auth: { image: { style: "basic" } } }, /style must be one of/],
      [{ noAuth: "yes" }, /must be true or false/],
    ];
    for (const [value, re] of bad) {
      const out = validateMediaConfig(value);
      expect(out.ok, JSON.stringify(value)).toBe(false);
      expect(out.detail).toMatch(re);
    }
    expect(AUTH_STYLES).toContain("none"); // noAuth endpoints are a real case
  });
});

describe("kind on the stored rows", () => {
  it("defaults everything written before media to chat", () => {
    // Exactly the state a pre-v6 install is in: rows exist and nothing said what kind they are.
    const n = node("legacy", null);
    db.prepare(`INSERT INTO node_models (id, node_id, model, source, enabled, stale, created_at, updated_at)
                VALUES ('m-legacy', ?, 'gpt-x', 'manual', 1, 0, '2026-01-01', '2026-01-01')`).run(n.id);
    const row = repos.nodeModels.get("m-legacy");
    expect(row.kind).toBe("llm");

    const ev = repos.usage.record({ model: "legacy/gpt-x", status: "ok" });
    expect(ev.id).toBeGreaterThan(0);
    expect(repos.usage.query({ limit: 1 })[0].kind).toBe("llm");

    expect(repos.combos.create({ name: "plain", models: ["legacy/gpt-x"] }).kind).toBe("llm");
  });

  it("keeps a model's kind when it is re-added without one", () => {
    const n = node("img", { kinds: ["image"] });
    const added = repos.nodeModels.create({ nodeId: n.id, model: "img-1", kind: "image" });
    expect(added.kind).toBe("image");
    // The UI's "add model" path does not always send a kind; a bare re-add must not demote it.
    expect(repos.nodeModels.create({ nodeId: n.id, model: "img-1" }).kind).toBe("image");
  });
});

describe("what discovery exposes", () => {
  it("leaves the chat list exactly as it was", () => {
    const chat = node("chat", null);
    repos.nodeModels.create({ nodeId: chat.id, model: "gpt-x" });
    const media = node("pix", { kinds: ["image"] });
    repos.nodeModels.create({ nodeId: media.id, model: "flux-1", kind: "image" });

    const ids = listModels(repos).data.map((m) => m.id);
    expect(ids).toContain("chat/gpt-x");
    expect(ids).not.toContain("pix/flux-1"); // an image model is not a chat model
    expect(ids).toContain("pix/*"); // a node with no chat models still advertises its prefix
    expect(listModels(repos).data.every((m) => m.kind === undefined)).toBe(true);
  });

  it("lists a media kind by its own rule, carrying the kind", () => {
    const pix = node("pix", { kinds: ["image", "embedding"] });
    repos.nodeModels.create({ nodeId: pix.id, model: "flux-1", kind: "image" });
    repos.nodeModels.create({ nodeId: pix.id, model: "emb-1", kind: "embedding" });

    expect(listModels(repos, { kind: "image" }).data).toEqual([
      { id: "pix/flux-1", object: "model", kind: "image", owned_by: "routy-node:pix" },
    ]);
    expect(listModels(repos, { kind: "embedding" }).data.map((m) => m.id)).toEqual(["pix/emb-1"]);
    expect(listModels(repos, { kind: "tts" }).data).toEqual([]); // declared kinds only

    // "the provider IS the model": web kinds list the prefix, not a fabricated model id
    const web = node("jina", { kinds: ["webFetch"] });
    expect(listModels(repos, { kind: "webFetch" }).data).toEqual([
      { id: "jina", object: "model", kind: "webFetch", owned_by: "routy-node:jina" },
    ]);
    expect(web.id).toBeTruthy();
  });

  it("keeps a media combo out of the chat list, and vice versa", () => {
    const pix = node("pix", { kinds: ["image"] });
    repos.nodeModels.create({ nodeId: pix.id, model: "flux-1", kind: "image" });
    repos.combos.create({ name: "image-combo", models: ["pix/flux-1"], kind: "image" });
    repos.combos.create({ name: "chat-combo", models: ["pix/*"] });

    const chat = listModels(repos).data.map((m) => m.id);
    expect(chat).toContain("chat-combo");
    expect(chat).not.toContain("image-combo");

    const image = listModels(repos, { kind: "image" }).data.map((m) => m.id);
    expect(image).toContain("image-combo");
    expect(image).not.toContain("chat-combo");
  });
});

describe("resolving a request to a target", () => {
  it("only reaches a node that declares the kind", () => {
    node("plain", null);
    node("pix", { kinds: ["image"] });

    expect(resolveRoute(repos, "plain/m1")).toMatchObject({ kind: "node" });          // chat: any node
    expect(resolveRoute(repos, "pix/flux-1", { kind: "image" })).toMatchObject({ model: "flux-1" });
    expect(resolveRoute(repos, "plain/m1", { kind: "image" })).toBeNull();            // not declared
  });

  it("accepts a bare prefix only where the provider IS the model", () => {
    node("plain", null);
    node("jina", { kinds: ["webFetch"] });
    node("ttsbox", { kinds: ["tts"] });

    expect(resolveRoute(repos, "jina", { kind: "webFetch" })).toMatchObject({ model: null });
    // tts names a voice in the model field, so a bare prefix has nothing to dispatch to
    expect(resolveRoute(repos, "ttsbox", { kind: "tts" })).toBeNull();
    // and chat never accepted a bare prefix — that must not change
    expect(resolveRoute(repos, "plain")).toBeNull();
  });

  it("answers what a request would actually do", () => {
    const n = node("pix", {
      kinds: ["image"],
      urls: { image: "https://api.example.com/v1/images/generations" },
      auth: { image: { style: "x-api-key" } },
    });
    expect(n.id).toBeTruthy();

    expect(modelInfo(repos, "pix/flux-1", { kind: "image" })).toMatchObject({
      kind: "image", provider: "pix", model: "flux-1",
      endpoint: { method: "POST", path: "/v1/images/generations" },
      url: "https://api.example.com/v1/images/generations",
      auth: { style: "x-api-key" },
    });
    expect(modelInfo(repos, "pix/flux-1", { kind: "chat" })).toBeNull();
    expect(modelInfo(repos, "nope/m1")).toBeNull();
  });

  // A provider's own model name — `flux-1`, `text-embedding-3-small` — reaches it when
  // exactly one node serves that name for the kind. One match is a fact; two is a question only
  // the caller can answer, so an ambiguous bare id must NOT be guessed at (the first node in
  // list order would win silently, which is how a request reaches the wrong provider).
  it("resolves a bare model id when exactly one node serves it", () => {
    const n = node("pix2", { kinds: ["image"] });
    repos.nodeModels.create({ nodeId: n.id, model: "flux-1", kind: "image" });

    expect(resolveRoute(repos, "flux-1", { kind: "image" })).toMatchObject({ kind: "node", model: "flux-1" });
    expect(resolveRoute(repos, "pix2/flux-1", { kind: "image" })).toMatchObject({ model: "flux-1" });
    // and it stays a media-only capability: chat never resolved a bare model id
    expect(resolveRoute(repos, "flux-1")).toBeNull();
    // a kind nobody declares that model for does not resolve it either
    expect(resolveRoute(repos, "flux-1", { kind: "embedding" })).toBeNull();
  });

  it("refuses to guess when two nodes carry the same bare id", () => {
    const a = node("a-img", { kinds: ["image"] });
    const b = node("b-img", { kinds: ["image"] });
    repos.nodeModels.create({ nodeId: a.id, model: "flux-1", kind: "image" });
    repos.nodeModels.create({ nodeId: b.id, model: "flux-1", kind: "image" });

    expect(resolveRoute(repos, "flux-1", { kind: "image" })).toBeNull(); // ambiguous
    expect(resolveRoute(repos, "a-img/flux-1", { kind: "image" })).toMatchObject({ model: "flux-1" });
    expect(resolveRoute(repos, "b-img/flux-1", { kind: "image" })).toMatchObject({ model: "flux-1" });
    // Neither can info pick one: two candidates, so there is no single dispatch config to
    // report — the endpoint says which nodes carry it instead (asserted over HTTP below).
    expect(modelInfo(repos, "flux-1", { kind: "image" })).toBeNull();
  });
});

describe("the HTTP surface", () => {
  it("serves per-kind discovery, including the web alias", async () => {
    const web = node("tavily", { kinds: ["webSearch", "webFetch"] });
    expect(web.id).toBeTruthy();

    expect((await get("/v1/models/image")).body).toEqual({ object: "list", data: [] });

    const both = (await get("/v1/models/web")).body.data.map((m) => m.kind).sort();
    expect(both).toEqual(["webFetch", "webSearch"]); // both kinds, each naming itself

    const unknown = await get("/v1/models/images");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.detail).toContain("not a kind");
  });

  it("serves the same list to the dashboard", async () => {
    node("pix", { kinds: ["image"] });
    expect((await get("/api/models/image")).status).toBe(200);
    expect((await get("/api/models/image")).body.data).toEqual([]);
    expect((await get("/api/models/nonsense")).status).toBe(400);
  });

  it("answers /v1/models/info without being told the kind", async () => {
    node("jina", { kinds: ["webFetch"], urls: { webFetch: "https://r.jina.ai" } });
    const found = await get("/v1/models/info?id=jina");
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ kind: "webFetch", provider: "jina", url: "https://r.jina.ai" });

    expect((await get("/v1/models/info?id=nope")).status).toBe(404);
    expect((await get("/v1/models/info")).status).toBe(400);
    // "chat" is not a kind id — the vocabulary is `llm`, and the error says so
    const wrongName = await get("/v1/models/info?id=jina&kind=chat");
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.detail).toContain("llm");
    // ...whereas a real kind that this id is not routable as is simply not found
    expect((await get("/v1/models/info?id=jina&kind=llm")).status).toBe(404);
  });

  // Found by running the endpoint, not by reading it. Chat resolution accepts ANY node, so an
  // id belonging to an image model resolved as chat and the answer named the chat endpoint for a
  // request that could only ever go to /v1/images/generations. The model row knows what it is;
  // ask it instead of asking the loosest kind first.
  it("reports the kind a model is actually registered as", async () => {
    const pix = node("pix", { kinds: ["image"], urls: { image: "https://pix.test/v1/images/generations" } });
    await post(`/api/nodes/${pix.id}/models`, { model: "flux-1", kind: "image" });

    const info = await get("/v1/models/info?id=pix/flux-1");
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      kind: "image",
      endpoint: { method: "POST", path: "/v1/images/generations" },
      url: "https://pix.test/v1/images/generations",
    });
  });

  it("says which kinds to choose from when a bare prefix is ambiguous", async () => {
    node("both", { kinds: ["webSearch", "webFetch"] });
    const ambiguous = await get("/v1/models/info?id=both");
    expect(ambiguous.status).toBe(404);
    expect(ambiguous.body.error.detail).toContain("?kind=");
    expect(ambiguous.body.error.detail).toContain("webSearch");
    expect((await get("/v1/models/info?id=both&kind=webFetch")).status).toBe(200);
  });

  // Two nodes carrying the same bare model name: there is no single answer, so the refusal has
  // to say who carries it — otherwise the caller is told "not routable" while the model plainly
  // exists on both nodes.
  it("names the nodes carrying a bare id that more than one serves", async () => {
    const a = node("a-img", { kinds: ["image"] });
    const b = node("b-img", { kinds: ["image"] });
    repos.nodeModels.create({ nodeId: a.id, model: "flux-1", kind: "image" });
    repos.nodeModels.create({ nodeId: b.id, model: "flux-1", kind: "image" });

    const r = await get("/v1/models/info?id=flux-1");
    expect(r.status).toBe(404);
    expect(r.body.error.detail).toContain("carried by 2 nodes");
    expect(r.body.error.detail).toContain("a-img, b-img");
    expect(r.body.error.detail).toContain("<prefix>/<model>");

    // with a prefix there is nothing ambiguous to report
    expect((await get("/v1/models/info?id=a-img/flux-1")).status).toBe(200);
  });
});

describe("the API is where a config is refused", () => {
  it("rejects a bad media config and stores nothing", async () => {
    const created = await post("/api/nodes", { name: "x", prefix: "x1", baseUrl: "http://127.0.0.1:1/v1", data: { media: { kinds: ["images"] } } });
    expect(created.status).toBe(400);
    expect(created.body.error.detail).toContain("not a kind");
    expect(repos.nodes.byPrefix("x1")).toBeNull();
  });

  it("replaces media on update, so a kind can be removed", async () => {
    const created = await post("/api/nodes", {
      name: "multi", prefix: "multi", baseUrl: "http://127.0.0.1:1/v1",
      data: { media: { kinds: ["image", "embedding"] }, pricing: { inputPer1M: 3 } },
    });
    expect(created.status).toBe(201);
    expect(created.body.mediaKinds).toEqual(["image", "embedding"]);

    const updated = await put(`/api/nodes/${created.body.id}`, { data: { media: { kinds: ["image"] } } });
    expect(updated.status).toBe(200);
    expect(updated.body.mediaKinds).toEqual(["image"]);                   // removed, not merged
    expect(updated.body.data.pricing).toEqual({ inputPer1M: 3 });         // other settings survive

    const bad = await put(`/api/nodes/${created.body.id}`, { data: { media: { noAuth: "yes" } } });
    expect(bad.status).toBe(400);
    expect(repos.nodes.get(created.body.id).data.media.kinds).toEqual(["image"]); // unchanged
  });

  it("refuses a model whose kind the node does not declare", async () => {
    const created = await post("/api/nodes", { name: "only-chat", prefix: "oc", baseUrl: "http://127.0.0.1:1/v1" });
    const rejected = await post(`/api/nodes/${created.body.id}/models`, { model: "flux-1", kind: "image" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.detail).toContain("does not declare");

    const ok = await post(`/api/nodes/${created.body.id}/models`, { model: "gpt-x" });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe("llm");
  });

  it("refuses a combo kind that is not a kind", async () => {
    expect((await post("/api/combos", { name: "c1", models: [], kind: "images" })).status).toBe(400);
    expect((await post("/api/combos", { name: "c2", models: [], kind: "image" })).status).toBe(201);
  });
});
