// Web fetch (docs/media-providers.md §8 M4) — the one kind where the CLIENT names the target.
//
// The SSRF cases are the point of this file: the reference implementation refuses a
// client-supplied URL unless it is public http(s) (`assertPublicUrl`), and this gateway does the
// same before it chooses a provider — because a refused target must not depend on which provider
// would have been asked, and because an API key is not a person.
//
// The target URLs here are public (`https://example.org/...`) while the PROVIDER is a local stub:
// routy never fetches the target itself, it asks the provider to, so the check is real and the
// test needs no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createFetchHandler } from "../core/handlers/fetch.mjs";
import { createRouter, json } from "../lib/router.mjs";

let tmp, db, repos, server, port, stubServer, stubPort, stubState;

const post = (p, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-fetch-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });

  stubState = { calls: [], responses: [] };
  stubServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
      stubState.calls.push({ url: req.url, method: req.method, headers: req.headers, body });
      const script = stubState.responses.shift();
      if (script) {
        res.writeHead(script.status, { "content-type": script.contentType ?? "application/json" });
        return res.end(typeof script.body === "string" ? script.body : JSON.stringify(script.body ?? {}));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { title: "Example Page", content: "# Heading\n\nBody text", links: ["https://example.org/next"] }, meta: { language: "en" } }));
    });
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => { stubPort = stubServer.address().port; r(); }));

  const dispatch = createRouter([
    ...buildApiRoutes(repos, { bootstrapToken: "tok" }, "0.1.0"),
    ...buildProxyRoutes(repos, {
      chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }),
      handlers: { fetch: createFetchHandler(repos, { timeoutMs: 5_000 }) },
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

const POST_MAP = {
  headers: { "x-respond-with": "markdown" },
  request: { url: "target", format: "respond_with" },
  response: { fields: { title: "data.title", "content.text": "data.content", links: "data.links", "metadata.language": "meta.language" } },
};

const GET_MAP = {
  method: "GET",
  request: { url: "u", format: "f" },
  response: { fields: { title: "page.title", "content.text": "page.text" } },
};

function fetchNode(prefix, map, { url, keys = ["sk-fetch"] } = {}) {
  const node = repos.nodes.create({
    name: prefix, prefix, apiType: "openai",
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    data: { media: { kinds: ["webFetch"], urls: { webFetch: url ?? `http://127.0.0.1:${stubPort}/fetch` }, map: { webFetch: map } } },
  });
  keys.forEach((apiKey, i) => repos.connections.create({ nodeId: node.id, name: `${prefix} key ${i + 1}`, credentials: { apiKey } }));
  repos.nodeModels.create({ nodeId: node.id, model: "fetch", kind: "webFetch" });
  return node;
}

describe("a fetch provider, normalized", () => {
  it("renames the request, sends its static header, and normalizes nested content", async () => {
    fetchNode("reader", POST_MAP);
    const r = await post("/v1/web/fetch", { model: "reader/fetch", url: "https://example.org/page", format: "markdown" });

    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("reader");
    expect(r.body.url).toBe("https://example.org/page");
    expect(r.body.title).toBe("Example Page");
    expect(r.body.content).toMatchObject({ format: "markdown", text: "# Heading\n\nBody text", length: "# Heading\n\nBody text".length });
    expect(r.body.links).toEqual(["https://example.org/next"]);
    expect(r.body.metadata).toEqual({ language: "en" });

    const call = stubState.calls[0];
    expect(call.body).toEqual({ target: "https://example.org/page", respond_with: "markdown" });
    expect(call.headers["x-respond-with"]).toBe("markdown");
    expect(call.headers.authorization).toBe("Bearer sk-fetch");
  });

  it("supports a GET provider with its parameters in the query string", async () => {
    fetchNode("querier", GET_MAP);
    stubState.responses = [{ status: 200, body: { page: { title: "Q", text: "q-text" } } }];
    const r = await post("/v1/web/fetch", { model: "querier/fetch", url: "https://example.org/q", format: "text" });

    expect(r.status).toBe(200);
    expect(r.body.content).toMatchObject({ format: "text", text: "q-text" });
    const call = stubState.calls[0];
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/fetch?u=https%3A%2F%2Fexample.org%2Fq&f=text");
  });

  it("truncates at the edge, and treats 0 as 'no limit'", async () => {
    fetchNode("reader", POST_MAP);
    const cut = await post("/v1/web/fetch", { model: "reader/fetch", url: "https://example.org/page", max_characters: 5 });
    expect(cut.body.content.text).toBe("# Hea");
    expect(cut.body.content.length).toBe(5);
    expect(cut.body.truncated).toBe(true);

    const whole = await post("/v1/web/fetch", { model: "reader/fetch", url: "https://example.org/page", max_characters: 0 });
    expect(whole.body.content.text).toBe("# Heading\n\nBody text");
    expect(whole.body.truncated).toBeUndefined();
  });

  it("refuses a provider with no mapping", async () => {
    const node = repos.nodes.create({
      name: "nomap", prefix: "nomap", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      data: { media: { kinds: ["webFetch"], urls: { webFetch: `http://127.0.0.1:${stubPort}/fetch` } } },
    });
    repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x" } });
    const r = await post("/v1/web/fetch", { model: "nomap/fetch", url: "https://example.org/p" });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("no webFetch mapping");
    expect(stubState.calls).toHaveLength(0);
  });
});

describe("the target URL is checked before anything else", () => {
  beforeEach(() => fetchNode("reader", POST_MAP));

  it("refuses loopback, private and non-http targets, naming the reason", async () => {
    const cases = [
      ["http://127.0.0.1:8080/admin", /127\.0\.0\.1/],
      ["http://10.0.0.5/internal", /10\.0\.0\.5/],
      ["http://169.254.169.254/latest/meta-data", /169\.254\.169\.254/],
      ["http://localhost/", /local hostname/],
      ["file:///etc/passwd", /http\(s\)/],
      ["data:text/html,<h1>x</h1>", /http\(s\)/],
    ];
    for (const [target, re] of cases) {
      const r = await post("/v1/web/fetch", { model: "reader/fetch", url: target });
      expect(r.status, target).toBe(400);
      expect(r.body.error.message, target).toBe("url_refused");
      expect(r.body.error.detail, target).toMatch(re);
    }
    expect(stubState.calls).toHaveLength(0); // refused before any provider was chosen or called
  });

  it("accepts a public target", async () => {
    const r = await post("/v1/web/fetch", { model: "reader/fetch", url: "https://example.org/ok" });
    expect(r.status).toBe(200);
    expect(stubState.calls).toHaveLength(1);
  });

  it("validates the request shape before the URL", async () => {
    expect((await post("/v1/web/fetch", { model: "reader/fetch" })).body.error.detail).toContain("url required");
    expect((await post("/v1/web/fetch", { model: "reader/fetch", url: "https://example.org/p", format: "pdf" })).body.error.detail).toContain("format must be one of");
    expect((await post("/v1/web/fetch", { model: "reader/fetch", url: "https://example.org/p", max_characters: -1 })).body.error.detail).toContain("max_characters");
    expect(stubState.calls).toHaveLength(0);
  });
});

describe("a combo of fetch providers", () => {
  it("fails over to the next member", async () => {
    const first = fetchNode("f-alpha", POST_MAP);
    fetchNode("f-beta", GET_MAP);
    repos.combos.create({ name: "fetch-combo", models: ["f-alpha/fetch", "f-beta/fetch"], kind: "webFetch" });
    stubState.responses = [
      { status: 429, body: { error: { message: "rate limit" } } },
      { status: 200, body: { page: { title: "B", text: "from beta" } } },
    ];

    const r = await post("/v1/web/fetch", { model: "fetch-combo", url: "https://example.org/p" });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("f-beta");
    expect(r.body.content.text).toBe("from beta");
    expect(stubState.calls).toHaveLength(2);
    // A per-key 429 is the key's, not the node's: the breaker stays clean and the member is
    // simply not the one that served this request.
    expect(repos.breakers.get(`node:${first.id}`)?.failures ?? 0).toBe(0);
  });
});
