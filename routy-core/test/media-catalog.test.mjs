// The media provider catalogue (core/mediaCatalog.mjs).
//
// The claim this file defends is "routy follows 9Router's media providers", which is only worth
// anything if it is checkable: every supported provider's preset must be a config the API's own
// validator accepts, and every unsupported one must say which code path it needs instead. The
// counts are asserted by NAME rather than by number, so dropping a provider fails loudly here
// instead of quietly shrinking the catalogue.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { createRouter } from "../lib/router.mjs";
import { MEDIA_KIND_IDS, AUTH_STYLES, validateMediaConfig } from "../core/media.mjs";
import { MEDIA_CATALOG, catalogEntry, catalogFor, catalogSummary, presetFor } from "../core/mediaCatalog.mjs";

const ALL = MEDIA_KIND_IDS.flatMap((kind) => catalogFor(kind).map((p) => ({ kind, ...p })));

describe("the catalogue as data", () => {
  it("covers exactly the kinds routy serves", () => {
    expect(Object.keys(MEDIA_CATALOG).sort()).toEqual([...MEDIA_KIND_IDS].sort());
  });

  it("has no duplicate ids, and an id is unique within its kind", () => {
    for (const kind of MEDIA_KIND_IDS) {
      const ids = catalogFor(kind).map((p) => p.id);
      expect(new Set(ids).size, kind).toBe(ids.length);
    }
  });

  it("names every provider 9Router ships for the web kinds", () => {
    // 9Router's registry: five fetch providers, and these search providers with a real search API.
    expect(catalogFor("webFetch").map((p) => p.id).sort()).toEqual(["exa", "firecrawl", "jina-reader", "ollama", "tavily"]);
    const search = catalogFor("webSearch").map((p) => p.id);
    for (const id of ["tavily", "exa", "serper", "brave-search", "google-pse", "linkup", "searchapi", "youcom", "searxng", "ollama-search", "xquik", "glm"]) {
      expect(search, id).toContain(id);
    }
    // …and the nine that 9Router answers by prompting a chat model are present as themselves,
    // not omitted: a provider missing from the list reads as "9Router does not have it".
    for (const id of ["openai", "gemini", "perplexity", "perplexity-agent", "kimi", "minimax", "xai", "antigravity", "vercel-ai-gateway"]) {
      expect(search, id).toContain(id);
      expect(catalogFor("webSearch").find((p) => p.id === id).chatModel).toBeTruthy();
    }
  });

  it("gives every supported provider a preset the API's own validator accepts", () => {
    let checked = 0;
    for (const p of ALL) {
      if (p.supported === false) continue;
      if (p.auth) expect(AUTH_STYLES, `${p.kind}/${p.id}`).toContain(p.auth);
      const preset = presetFor(p.kind, p.id);
      expect(preset, `${p.kind}/${p.id}`).toBeTruthy();
      const checkedConfig = validateMediaConfig(preset.data.media);
      expect(checkedConfig.ok, `${p.kind}/${p.id}: ${checkedConfig.detail}`).toBe(true);
      // A web provider without a mapping cannot be called at all, so "supported" would be a lie.
      if (p.kind === "webSearch" || p.kind === "webFetch") {
        expect(preset.data.media.map?.[p.kind], `${p.kind}/${p.id}`).toBeTruthy();
      }
      expect(preset.data.media.urls?.[p.kind], `${p.kind}/${p.id}`).toBeTruthy();
      checked++;
    }
    expect(checked).toBe(ALL.filter((p) => p.supported !== false).length);
  });

  it("makes an unsupported provider explain itself and offer nothing to apply", () => {
    const unsupported = ALL.filter((p) => p.supported === false);
    expect(unsupported.length).toBeGreaterThan(0);
    for (const p of unsupported) {
      // A reason, not a shrug — and where the mechanism has a structured name (9Router's `format`
      // selector, or the chat model standing in for a search), it is carried as data too.
      expect(typeof p.why, `${p.kind}/${p.id}`).toBe("string");
      expect(p.why.trim().length, `${p.kind}/${p.id}`).toBeGreaterThanOrEqual(8);
      if (p.kind === "tts" && p.id !== "openrouter" && p.id !== "selfhosted-tts") {
        expect(p.format, `${p.kind}/${p.id}`).toBeTruthy();
      }
      expect(presetFor(p.kind, p.id), `${p.kind}/${p.id}`).toBeNull();
    }
  });

  it("omits the providers 9Router itself cannot serve", () => {
    // These are registered for their kind in 9Router but have no adapter there — its own cores
    // answer 400 for them (embeddingsCore.js:32-35, imageGenerationCore.js:45-48, ttsCore.js:67-70).
    // Listing them would copy a bug that looks like support.
    const dead = [
      ["embedding", "tokenrouter"],
      ["embedding", "venice"],
      ["image", "tokenrouter"],
      ["image", "venice"],
      ["image", "topaz"],
      ["tts", "aws-polly"],
    ];
    for (const [kind, id] of dead) {
      expect(catalogEntry(kind, id), `${kind}/${id}`).toBeNull();
    }
    // …and every provider that IS listed for an OpenAI-shaped kind still carries a usable preset.
    for (const [kind] of dead) {
      for (const p of catalogFor(kind)) if (p.supported !== false) expect(presetFor(kind, p.id), `${kind}/${p.id}`).toBeTruthy();
    }
  });

  it("counts what it can honestly claim", () => {
    const fetch = catalogSummary("webFetch");
    expect(fetch).toEqual({ kind: "webFetch", total: 5, supported: 5, unsupported: 0 });
    const search = catalogSummary("webSearch");
    expect(search.supported).toBeGreaterThanOrEqual(10);
    expect(search.supported + search.unsupported).toBe(search.total);
  });
});

describe("the catalogue over HTTP", () => {
  let tmp, db, repos, server, port;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-catalog-"));
    db = openDatabase(tmp);
    repos = createRepos(db);
    repos.settings.update({ requireApiKey: false });
    const dispatch = createRouter(buildApiRoutes(repos, { bootstrapToken: "tok" }, "0.1.0"));
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

  const get = (p) =>
    new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: p, headers: { "x-routy-action": "1" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }).on("error", reject);
    });

  it("serves every kind with a preset ready to apply", async () => {
    const r = await get("/api/media/catalog");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.kinds).sort()).toEqual([...MEDIA_KIND_IDS].sort());

    const jina = r.body.kinds.webFetch.find((p) => p.id === "jina-reader");
    expect(jina.supported).toBe(true);
    expect(jina.preset.media.urls.webFetch).toBe("https://r.jina.ai/");
    // The preset IS a node config: applying it must satisfy the same validator the API uses.
    expect(validateMediaConfig(jina.preset.media).ok).toBe(true);

    const glm = r.body.kinds.webSearch.find((p) => p.id === "glm");
    expect(glm.supported).toBe(false);
    expect(glm.preset).toBeNull();
    expect(glm.why).toMatch(/JSON-RPC/);
  });
});
