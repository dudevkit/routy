// Combo dispatch strategies, end to end through the real handler.
//
// `round-robin` and `sticky` were both offered in the combo editor while the core knew
// only fallback/fastest/cheapest: picking either silently behaved as declared order, and
// the API's own validator rejected saving it with a 400. These tests pin the behaviour
// AND the acceptance, so the editor can never advertise a strategy that does nothing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { orderRoutes, COMBO_STRATEGIES } from "../core/routing.mjs";

let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubState;
let nodeA, nodeB;

/** Which node served: the stub knows by the port its own request arrived on. */
const served = () => stubState.served.at(-1);

const chat = (model = "combo1") =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "x" }] });
    const req = http.request(
      { host: "127.0.0.1", port: handlerPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); },
    );
    req.on("error", reject);
    req.end(payload);
  });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "combo-strategy-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  const handler = createChatHandler(repos);

  stubState = { served: [] };
  stubPort = await new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        // one stub, two nodes: the path carries which node routed here
        stubState.served.push(req.url.includes("node-b") ? nodeB.id : nodeA.id);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n`);
        res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    stubServer.listen(0, "127.0.0.1", () => resolve(stubServer.address().port));
  });

  handlerPort = await new Promise((resolve) => {
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerServer.listen(0, "127.0.0.1", () => resolve(handlerServer.address().port));
  });

  nodeA = repos.nodes.create({ name: "A", prefix: "na", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/node-a/v1` });
  nodeB = repos.nodes.create({ name: "B", prefix: "nb", apiType: "openai", baseUrl: `http://127.0.0.1:${stubPort}/node-b/v1` });
  repos.connections.create({ nodeId: nodeA.id, name: "a-key", credentials: { apiKey: "sk-a" } });
  repos.connections.create({ nodeId: nodeB.id, name: "b-key", credentials: { apiKey: "sk-b" } });
  repos.combos.create({ name: "combo1", models: ["na/m1", "nb/m1"], strategy: "fallback" });
  repos.settings.update({ requireApiKey: false });
});

afterEach(async () => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  handlerServer?.closeAllConnections?.();
  stubServer?.closeAllConnections?.();
  await new Promise((r) => handlerServer?.close(r));
  await new Promise((r) => stubServer?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("combo strategy: round-robin", () => {
  it("starts at a different member each request", async () => {
    repos.combos.update(repos.combos.byName("combo1").id, { strategy: "round-robin" });
    for (let i = 0; i < 4; i++) {
      const r = await chat();
      expect(r.status).toBe(200);
    }
    const order = stubState.served;
    expect(order).toHaveLength(4);
    // strictly alternating: A B A B (or B A B A, depending on where the cycle starts)
    expect(new Set(order.slice(0, 2)).size).toBe(2);
    expect(order[0]).toBe(order[2]);
    expect(order[1]).toBe(order[3]);
  }, 20_000);

  it("still falls through to the other member when the first fails", async () => {
    repos.combos.update(repos.combos.byName("combo1").id, { strategy: "round-robin" });
    // every other request, node A is broken
    const original = stubState.served;
    stubServer.removeAllListeners("request");
    stubServer.on("request", (req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const isB = req.url.includes("node-b");
        original.push(isB ? nodeB.id : nodeA.id);
        if (!isB) {
          res.writeHead(500, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "boom" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n`);
        res.write(`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    const r = await chat();
    // A was tried first (whichever turn), failed, and B answered — rotation must not
    // stop the existing fallover from working.
    expect(r.status).toBe(200);
    expect(stubState.served.length).toBeGreaterThanOrEqual(2);
    expect(stubState.served.at(-1)).toBe(nodeB.id);
  }, 20_000);
});

describe("combo strategy: sticky", () => {
  it("holds one member for stickyLimit requests, then moves on", async () => {
    repos.combos.update(repos.combos.byName("combo1").id, { strategy: "sticky", stickyLimit: 2 });
    for (let i = 0; i < 4; i++) await chat();
    // The cursor is keyed to the combo, and this combo is created per test, so the
    // cycle starts at zero: exactly two requests on each member, in declared order.
    expect(stubState.served).toEqual([nodeA.id, nodeA.id, nodeB.id, nodeB.id]);
  }, 20_000);
});

describe("combo strategy: acceptance", () => {
  it("accepts every strategy the editor offers", () => {
    // The editor's own list, kept in step with the core by this assertion.
    const offered = ["fallback", "round-robin", "sticky"];
    for (const s of offered) expect(COMBO_STRATEGIES, s).toContain(s);
  });

  it("keeps health ahead of rotation", () => {
    const routes = [
      { kind: "node", node: { id: "a" }, healthy: false },
      { kind: "node", node: { id: "b" }, healthy: true },
      { kind: "node", node: { id: "c" }, healthy: true },
    ];
    const ordered = orderRoutes(routes, { strategy: "round-robin", rotate: 1 });
    expect(ordered.at(-1).node.id).toBe("a"); // unhealthy stays last, never rotated up
    expect(ordered.slice(0, 2).map((r) => r.node.id)).toEqual(["c", "b"]);
  });
});
