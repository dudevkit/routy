// Web search (docs/media-providers.md §8 M4).
//
// Web search is the first kind whose provider call is BUILT from a mapping, and the first media
// kind that accepts a combo. Both are exercised here against two deliberately dissimilar provider
// shapes — a GET that renames its params and nests its results, and a POST that answers with an
// answer plus a cost — because "all providers similar" is only true if the *mapping* is what
// differs and nothing else does.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { buildProxyRoutes } from "../http/v1.mjs";
import { createSearchHandler } from "../core/handlers/search.mjs";
import { createRouter, json } from "../lib/router.mjs";
import { addSpend } from "../core/budget.mjs";
import { subscribeLog } from "../lib/log.mjs";

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

const put = (p, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "PUT", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-search-"));
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
      const call = { url: req.url, method: req.method, headers: req.headers, body };
      stubState.calls.push(call);
      const script = stubState.responses.shift();
      if (script) {
        res.writeHead(script.status, { "content-type": script.contentType ?? "application/json" });
        return res.end(typeof script.body === "string" ? script.body : JSON.stringify(script.body ?? {}));
      }
      // Default: answer in the shape the path implies (GET = the "searxng-like" provider).
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ hits: [{ t: "First", href: "https://first.example", s: "one", lang: "en" }, { t: "Second", href: "https://second.example", s: "two" }] }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Posted", url: "https://posted.example", content: "body", score: 0.91 }], answer: "yes", cost: 0.004 }));
    });
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => { stubPort = stubServer.address().port; r(); }));

  const dispatch = createRouter([
    ...buildApiRoutes(repos, { bootstrapToken: "tok" }, "0.1.0"),
    ...buildProxyRoutes(repos, {
      chatHandler: async (req, res) => json(res, 418, { error: { message: "stub" } }),
      handlers: { search: createSearchHandler(repos, { timeoutMs: 5_000 }) },
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

/** A GET provider: renamed params in the query string, results nested under `hits`. */
const GET_MAP = {
  method: "GET",
  request: { query: "q", max_results: "num" },
  headers: { accept: "application/json" },
  response: {
    results: "hits",
    fields: { title: "t", url: "href", snippet: "s", "metadata.language": "lang" },
  },
};

/** A POST provider: a JSON body, an answer and a cost at the top level. */
const POST_MAP = {
  request: { query: "query", max_results: "max_results" },
  response: {
    results: "results",
    fields: { title: "title", url: "url", snippet: "content", score: "score" },
    top: { answer: "answer", "usage.search_cost_usd": "cost" },
  },
};

function searchNode(prefix, map, { keys = ["sk-search"], url } = {}) {
  const node = repos.nodes.create({
    name: prefix, prefix, apiType: "openai",
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    data: { media: { kinds: ["webSearch"], urls: { webSearch: url ?? `http://127.0.0.1:${stubPort}/search` }, map: { webSearch: map } } },
  });
  keys.forEach((apiKey, i) => repos.connections.create({ nodeId: node.id, name: `${prefix} key ${i + 1}`, credentials: { apiKey } }));
  repos.nodeModels.create({ nodeId: node.id, model: "search", kind: "webSearch" });
  return node;
}

const breaker = (nodeId) => repos.breakers.get(`node:${nodeId}`);

describe("one shape, two providers", () => {
  it("builds a GET with renamed params and normalizes nested results", async () => {
    searchNode("getty", GET_MAP);
    const r = await post("/v1/search", { model: "getty/search", query: "routy gateway", max_results: 3, search_type: "news" });

    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("getty");
    expect(r.body.query).toBe("routy gateway");
    expect(r.body.results).toHaveLength(2);
    expect(r.body.results[0]).toMatchObject({ title: "First", url: "https://first.example", snippet: "one", position: 1, metadata: { language: "en" } });
    expect(Array.isArray(r.body.errors)).toBe(true);
    expect(r.body.metrics.response_time_ms).toBeGreaterThanOrEqual(0);

    const call = stubState.calls[0];
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/search?q=routy+gateway&num=3"); // renamed, and the unmapped field dropped
    expect(call.headers.accept).toBe("application/json");   // the mapping's static header
    expect(call.headers.authorization).toBe("Bearer sk-search");
  });

  it("builds a POST body and lifts the answer and the provider's own cost", async () => {
    searchNode("posty", POST_MAP, { url: `http://127.0.0.1:${stubPort}/api/search` });
    const r = await post("/v1/search", { model: "posty/search", query: "q2", max_results: 5 });

    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ title: "Posted", url: "https://posted.example", snippet: "body", score: 0.91 });
    expect(r.body.answer).toBe("yes");
    expect(r.body.usage.search_cost_usd).toBe(0.004);

    const call = stubState.calls[0];
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ query: "q2", max_results: 5 }); // no `model`, nothing invented
  });

  it("refuses a provider with no mapping, naming what to set", async () => {
    const node = repos.nodes.create({
      name: "nomap", prefix: "nomap", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      data: { media: { kinds: ["webSearch"], urls: { webSearch: `http://127.0.0.1:${stubPort}/search` } } },
    });
    repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x" } });

    const r = await post("/v1/search", { model: "nomap/search", query: "q" });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("no webSearch mapping");
    expect(stubState.calls).toHaveLength(0);
  });

  it("refuses a node that does not declare the kind", async () => {
    const node = repos.nodes.create({ name: "chatonly", prefix: "chatonly", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1` });
    repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk-x" } });
    const r = await post("/v1/search", { model: "chatonly/m1", query: "q" });
    expect(r.status).toBe(400);
    expect(r.body.error.detail).toContain("does not serve web search");
  });

  it("validates a mapping where it is authored", async () => {
    const node = searchNode("editable", POST_MAP);
    const bad = await put(`/api/nodes/${node.id}`, {
      data: { media: { kinds: ["webSearch"], urls: { webSearch: "http://127.0.0.1:9/s" }, map: { webSearch: { method: "PUT" } } } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.detail).toContain("must be POST or GET");
    expect(repos.nodes.get(node.id).data.media.map.webSearch.request.query).toBe("query"); // unchanged
  });
});

describe("a combo of search providers", () => {
  it("fails over to the next member and says so in the log", async () => {
    const first = searchNode("alpha", POST_MAP, { url: `http://127.0.0.1:${stubPort}/api/search` });
    const second = searchNode("beta", GET_MAP);
    repos.combos.create({ name: "search-combo", models: ["alpha/search", "beta/search"], kind: "webSearch" });
    stubState.responses = [{ status: 500, body: { error: { message: "boom" } } }]; // alpha fails

    const lines = [];
    const stop = subscribeLog((t) => lines.push(JSON.parse(t)));
    let r;
    try {
      r = await post("/v1/search", { model: "search-combo", query: "failover" });
    } finally {
      stop();
    }

    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("beta");            // the second member served it
    expect(stubState.calls).toHaveLength(2);         // alpha was tried, then beta
    expect(breaker(first.id).failures).toBe(1);      // the 5xx was alpha's, and it was charged

    const plan = lines.find((l) => l.tag === "SEARCH" && l.msg.includes("member(s)"));
    expect(plan).toBeTruthy();
    expect(plan.data.strategy).toBe("fallback");
    expect(plan.data.order).toEqual(["alpha/search", "beta/search"]);

    const served = lines.find((l) => l.tag === "SEARCH" && l.msg.includes("← ok"));
    expect(served.msg).toContain("search-combo → beta/search ← ok · try 2/2");
    expect(served.data.member).toBe("beta/search");
  });

  it("rotates members under round-robin, using the same cursor chat uses", async () => {
    searchNode("rr-a", POST_MAP, { url: `http://127.0.0.1:${stubPort}/api/search` });
    searchNode("rr-b", GET_MAP);
    repos.combos.create({ name: "rr-search", models: ["rr-a/search", "rr-b/search"], kind: "webSearch", strategy: "round-robin" });

    const served = [];
    for (let i = 0; i < 2; i++) served.push((await post("/v1/search", { model: "rr-search", query: `q${i}` })).body.provider);
    expect(served).toEqual(["rr-a", "rr-b"]); // who serves first rotates per request
  });

  it("skips a member that has no mapping instead of failing the request", async () => {
    searchNode("mapped", GET_MAP);
    const bare = repos.nodes.create({
      name: "unmapped", prefix: "unmapped", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      data: { media: { kinds: ["webSearch"], urls: { webSearch: `http://127.0.0.1:${stubPort}/search` } } },
    });
    repos.connections.create({ nodeId: bare.id, name: "k", credentials: { apiKey: "sk-x" } });
    repos.combos.create({ name: "mixed", models: ["unmapped/search", "mapped/search"], kind: "webSearch" });

    const r = await post("/v1/search", { model: "mixed", query: "q" });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("mapped");
    expect(stubState.calls).toHaveLength(1); // the unmapped member was skipped before any call
  });

  it("answers 503 with the members it could not use", async () => {
    const a = searchNode("off-a", GET_MAP);
    const b = searchNode("off-b", GET_MAP);
    repos.nodes.update(a.id, { enabled: false });
    repos.nodes.update(b.id, { enabled: false });
    repos.combos.create({ name: "dead", models: ["off-a/search", "off-b/search"], kind: "webSearch" });

    const r = await post("/v1/search", { model: "dead", query: "q" });
    expect(r.status).toBe(503);
    expect(r.body.error.message).toBe("all_unavailable");
    expect(r.body.error.detail).toContain("every member of combo \"dead\" is unavailable");
    expect(stubState.calls).toHaveLength(0);
  });

  it("does not charge health for a request-shaped rejection", async () => {
    const node = searchNode("rejecter", POST_MAP, { url: `http://127.0.0.1:${stubPort}/api/search` });
    stubState.responses = [{ status: 400, body: { error: { message: "query is required" } } }];
    const r = await post("/v1/search", { model: "rejecter/search", query: "q" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("upstream_rejected");
    expect(breaker(node.id)?.failures ?? 0).toBe(0);
  });
});

describe("the daily budget is chat's, not media's", () => {
  // The two kinds of traffic are metered differently on purpose: the budget is denominated in USD
  // derived from chat token pricing, and a media request has no price in routy. Coupling them would
  // mean a spent chat budget silently 402s a web search, which is the bug this pins.
  it("serves a search while the chat budget is spent", async () => {
    const node = searchNode("budgeted", POST_MAP, { url: `http://127.0.0.1:${stubPort}/api/search` });
    // Metered on purpose: an unmetered node is kept by the budget filter either way, so the
    // request would succeed without proving anything about media.
    repos.nodes.update(node.id, { data: { ...node.data, pricing: { inputPer1M: 3, outputPer1M: 15 } } });
    addSpend(5);
    repos.settings.update({ budgetUsdPerDay: 0.01 });

    const r = await post("/v1/search", { model: "budgeted/search", query: "q" });
    expect(r.status).toBe(200);
    expect(stubState.calls).toHaveLength(1);
  });
});
