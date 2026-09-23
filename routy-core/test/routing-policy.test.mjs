// P4 — routing policy: combo strategy ordering, metered pricing, daily budget.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { orderRoutes, resolveRoute } from "../core/routing.mjs";
import { costOf, priceOf, isMetered } from "../core/pricing.mjs";
import { seedTtft, observeTtft, resetLatency, ttftOf } from "../core/latency.mjs";
import { budgetState, seedBudget, addSpend, resetBudget, startOfDay } from "../core/budget.mjs";

let tmp, db, repos;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-policy-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  resetLatency();
  resetBudget();
});

afterEach(() => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mkNode = (prefix, data = {}) =>
  repos.nodes.create({ name: prefix, prefix, apiType: "openai", baseUrl: `http://127.0.0.1/${prefix}`, data });
const conn = (node) => repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "k" } });

const routeFor = (repos_, model) => resolveRoute(repos_, model);

describe("pricing", () => {
  it("returns null for unmetered nodes and computes per-million cost for priced ones", () => {
    const free = mkNode("free");
    const paid = mkNode("paid", { pricing: { inputPer1M: 3, outputPer1M: 15 } });
    expect(priceOf(free)).toBeNull();
    expect(isMetered(free)).toBe(false);
    expect(costOf(free, { promptTokens: 1000, completionTokens: 1000 })).toBeNull();

    expect(isMetered(paid)).toBe(true);
    // 1000 prompt @ $3/1M + 1000 completion @ $15/1M
    expect(costOf(paid, { promptTokens: 1000, completionTokens: 1000 })).toBeCloseTo(0.003 + 0.015, 9);
  });

  it("treats a half-specified price as the other half being free", () => {
    const n = mkNode("half", { pricing: { inputPer1M: 2 } });
    expect(costOf(n, { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(2, 9);
  });

  it("ignores malformed pricing", () => {
    expect(priceOf(mkNode("bad", { pricing: { inputPer1M: "abc" } }))).toBeNull();
    expect(priceOf(mkNode("bad2", { pricing: "nope" }))).toBeNull();
  });
});

describe("combo strategy ordering", () => {
  it("keeps declared order for fallback", () => {
    const a = mkNode("a", { pricing: { inputPer1M: 99, outputPer1M: 99 } });
    const b = mkNode("b");
    conn(a); conn(b);
    seedTtft(a.id, 5); // a is fast AND expensive
    seedTtft(b.id, 500);
    const combo = repos.combos.create({ name: "c", models: ["a/m", "b/m"], strategy: "fallback" });
    const route = routeFor(repos, combo.name);
    expect(orderRoutes(route.routes, { strategy: route.strategy }).map((r) => r.node.prefix)).toEqual(["a", "b"]);
  });

  it("orders by latency for fastest", () => {
    const slow = mkNode("slow");
    const fast = mkNode("fast");
    conn(slow); conn(fast);
    seedTtft(slow.id, 900);
    seedTtft(fast.id, 30);
    const combo = repos.combos.create({ name: "c", models: ["slow/m", "fast/m"], strategy: "fastest" });
    const route = routeFor(repos, combo.name);
    expect(orderRoutes(route.routes, { strategy: "fastest" }).map((r) => r.node.prefix)).toEqual(["fast", "slow"]);
  });

  it("orders by price for cheapest, with unmetered nodes first", () => {
    const dear = mkNode("dear", { pricing: { inputPer1M: 10, outputPer1M: 10 } });
    const cheap = mkNode("cheap", { pricing: { inputPer1M: 1, outputPer1M: 1 } });
    const free = mkNode("free");
    conn(dear); conn(cheap); conn(free);
    const combo = repos.combos.create({ name: "c", models: ["dear/m", "cheap/m", "free/m"], strategy: "cheapest" });
    const route = routeFor(repos, combo.name);
    expect(orderRoutes(route.routes, { strategy: "cheapest" }).map((r) => r.node.prefix)).toEqual(["free", "cheap", "dear"]);
  });

  it("never lets a fast or cheap node jump ahead of an unhealthy one", () => {
    const down = mkNode("down");
    const up = mkNode("up");
    conn(down); conn(up);
    seedTtft(down.id, 1); // "fastest"
    repos.breakers.record(`node:${down.id}`, { state: "open", openUntil: new Date(Date.now() + 60_000).toISOString(), failureDelta: 3 });
    const combo = repos.combos.create({ name: "c", models: ["down/m", "up/m"], strategy: "fastest" });
    const route = routeFor(repos, combo.name);
    expect(orderRoutes(route.routes, { strategy: "fastest" }).map((r) => r.node.prefix)).toEqual(["up", "down"]);
  });

  it("probes nodes with unknown latency first, then ranks them on real data", () => {
    const known = mkNode("known");
    const unknown = mkNode("unknown");
    conn(known); conn(unknown);
    seedTtft(known.id, 400);
    const combo = repos.combos.create({ name: "c", models: ["known/m", "unknown/m"], strategy: "fastest" });
    const route = routeFor(repos, combo.name);
    // optimistic initialisation: the untried node gets explored
    expect(orderRoutes(route.routes, { strategy: "fastest" }).map((r) => r.node.prefix)).toEqual(["unknown", "known"]);
    // once measured as slow, it sinks below the known-fast node
    seedTtft(unknown.id, 900);
    expect(orderRoutes(route.routes, { strategy: "fastest" }).map((r) => r.node.prefix)).toEqual(["known", "unknown"]);
  });

  it("rejects an unknown strategy at the repo boundary by falling back", () => {
    const a = mkNode("a");
    conn(a);
    const combo = repos.combos.create({ name: "c", models: ["a/m"], strategy: "fallback" });
    const route = routeFor(repos, combo.name);
    expect(route.strategy).toBe("fallback");
    expect(orderRoutes(route.routes, { strategy: "bogus" }).length).toBe(1);
  });
});

describe("latency memory", () => {
  it("tracks an EWMA that moves toward recent samples", () => {
    seedTtft("n1", 100);
    expect(ttftOf("n1")).toBe(100);
    observeTtft("n1", 200);
    expect(ttftOf("n1")).toBeGreaterThan(100);
    expect(ttftOf("n1")).toBeLessThan(200);
    for (let i = 0; i < 30; i++) observeTtft("n1", 200);
    expect(ttftOf("n1")).toBeGreaterThan(195);
  });

  it("ignores junk samples", () => {
    observeTtft("n2", NaN);
    observeTtft("n2", -5);
    expect(ttftOf("n2")).toBeNull();
  });
});

describe("daily budget", () => {
  it("is unlimited when unset or zero", () => {
    expect(budgetState(undefined).configured).toBe(false);
    expect(budgetState(0).over).toBe(false);
    expect(budgetState(undefined).over).toBe(false);
  });

  it("trips at the ceiling and reports time to reset", () => {
    addSpend(2.5);
    const under = budgetState(5);
    expect(under.over).toBe(false);
    expect(under.remaining).toBeCloseTo(2.5, 9);

    addSpend(2.5);
    const over = budgetState(5);
    expect(over.over).toBe(true);
    expect(over.remaining).toBe(0);
    expect(over.retryAfterMs).toBeGreaterThan(0);
    expect(over.retryAfterMs).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it("seeds from persisted spend and ignores unmetered rows", () => {
    const node = mkNode("paid", { pricing: { inputPer1M: 1000, outputPer1M: 0 } });
    repos.usage.record({ nodeId: node.id, status: "ok", promptTokens: 1000, completionTokens: 0, costUsd: 1 });
    repos.usage.record({ nodeId: node.id, status: "ok", promptTokens: 1000, completionTokens: 0, costUsd: null });
    // yesterday's spend must not count against today
    repos.usage.record({ nodeId: node.id, status: "ok", promptTokens: 1000, completionTokens: 0, costUsd: 9, ts: startOfDay() - 1000 });

    expect(seedBudget(repos)).toBeCloseTo(1, 9);
    expect(budgetState(5).spent).toBeCloseTo(1, 9);
  });
});
