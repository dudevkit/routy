// P4 — budget + cost through the real request path: metered cost lands on the
// usage row, the ceiling refuses metered-only traffic, and an exhausted budget
// falls through to an unmetered route instead of failing the request.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { resetBudget } from "../core/budget.mjs";
import { resetLatency } from "../core/latency.mjs";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubHits;

function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        stubHits.push(JSON.parse(body).model);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`);
        res.write(`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":1000}}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-budget-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  resetBudget();
  resetLatency();
  stubHits = [];
  stubPort = await startStub();

  const handler = createChatHandler(repos);
  handlerPort = await new Promise((resolve) => {
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
  });

  repos.settings.update({ requireApiKey: false });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  handlerServer.closeAllConnections?.();
  stubServer.closeAllConnections?.();
  await new Promise((r) => handlerServer.close(r));
  await new Promise((r) => stubServer.close(r));
});

const mkNode = (prefix, data) =>
  repos.nodes.create({ name: prefix, prefix, apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/v1`, data });

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const ask = (model) => post({ model, stream: true, messages: [{ role: "user", content: "x" }] });

describe("cost recording", () => {
  it("writes a metered cost onto the usage row and leaves unmetered nodes null", async () => {
    const paid = mkNode("paid", { pricing: { inputPer1M: 3, outputPer1M: 15 } });
    const free = mkNode("free", {});
    repos.connections.create({ nodeId: paid.id, name: "k", credentials: { apiKey: "k" } });
    repos.connections.create({ nodeId: free.id, name: "k", credentials: { apiKey: "k" } });

    await ask("paid/m");
    await ask("free/m");

    const rows = repos.usage.query({ limit: 10 });
    const paidRow = rows.find((r) => r.node_id === paid.id);
    const freeRow = rows.find((r) => r.node_id === free.id);
    // 1000 prompt @ $3/1M + 1000 completion @ $15/1M
    expect(paidRow.cost_usd).toBeCloseTo(0.018, 9);
    expect(freeRow.cost_usd).toBeNull();
  });
});

describe("budget ceiling", () => {
  it("refuses metered-only traffic once the ceiling is reached", async () => {
    const paid = mkNode("paid", { pricing: { inputPer1M: 1000, outputPer1M: 1000 } });
    repos.connections.create({ nodeId: paid.id, name: "k", credentials: { apiKey: "k" } });
    repos.settings.update({ budgetUsdPerDay: 1 });

    const first = await ask("paid/m");
    expect(first.status).toBe(200); // 1000+1000 tokens @ $1000/1M = $2 → over the $1 ceiling

    const second = await ask("paid/m");
    expect(second.status).toBe(402);
    const err = JSON.parse(second.body).error;
    expect(err.message).toBe("budget_exceeded");
    expect(err.limitUsd).toBe(1);
    expect(err.spentUsd).toBeGreaterThanOrEqual(1);
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(stubHits.filter((m) => m === "m")).toHaveLength(1); // upstream was not called again
  });

  it("falls through to an unmetered node instead of failing (auto-fallback)", async () => {
    const paid = mkNode("paid", { pricing: { inputPer1M: 1000, outputPer1M: 1000 } });
    const free = mkNode("free", {});
    repos.connections.create({ nodeId: paid.id, name: "k", credentials: { apiKey: "k" } });
    repos.connections.create({ nodeId: free.id, name: "k", credentials: { apiKey: "k" } });
    repos.combos.create({ name: "pair", models: ["paid/m", "free/m"], strategy: "fallback" });
    repos.settings.update({ budgetUsdPerDay: 1 });

    await ask("pair"); // served by the paid node, blows the budget
    const after = await ask("pair");
    expect(after.status).toBe(200);
    expect(after.body).toContain("[DONE]");

    const rows = repos.usage.query({ limit: 10 });
    expect(rows[0].node_id).toBe(free.id); // the cheaper route took over
  });

  it("keeps serving normally while under the ceiling", async () => {
    const paid = mkNode("paid", { pricing: { inputPer1M: 1, outputPer1M: 1 } });
    repos.connections.create({ nodeId: paid.id, name: "k", credentials: { apiKey: "k" } });
    repos.settings.update({ budgetUsdPerDay: 100 });
    for (let i = 0; i < 3; i++) expect((await ask("paid/m")).status).toBe(200);
  });
});
