// P4 — Prometheus exposition: valid text format, real counters, windowing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { renderMetrics } from "../http/metrics.mjs";

let tmp, db, repos;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-metrics-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
});

afterEach(() => {
  try { repos.close(); db.close(); } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Parse the exposition text into { name: [{labels, value}] }. */
function parse(text) {
  const out = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{.*\})? (.+)$/);
    if (!m) throw new Error(`malformed sample line: ${line}`);
    const labels = m[2] ? Object.fromEntries([...m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]])) : {};
    (out[m[1]] ??= []).push({ labels, value: Number(m[3]) });
  }
  return out;
}

const sample = (parsed, name, labels = {}) =>
  parsed[name]?.find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;

describe("metrics exposition", () => {
  it("emits well-formed samples with matching HELP/TYPE for every family", () => {
    const text = renderMetrics(repos, { version: "9.9.9", inflight: 3 });
    const declared = new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]));
    const emitted = new Set(text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/[ {]/)[0]));
    expect(emitted.size).toBeGreaterThan(5);
    for (const name of emitted) expect(declared.has(name)).toBe(true);
    expect(() => parse(text)).not.toThrow();
  });

  it("counts requests, tokens and TTFT from usage events", () => {
    const node = repos.nodes.create({ name: "A", prefix: "a", apiType: "openai", baseUrl: "http://127.0.0.1:1/v1" });
    repos.usage.record({ nodeId: node.id, model: "a/m", status: "ok", promptTokens: 10, completionTokens: 20, ttftMs: 40 });
    repos.usage.record({ nodeId: node.id, model: "a/m", status: "ok", promptTokens: 5, completionTokens: 7, ttftMs: 60 });
    repos.usage.record({ nodeId: node.id, model: "a/m", status: "error", promptTokens: 1, completionTokens: 0 });

    const p = parse(renderMetrics(repos, { version: "0.1.0" }));
    expect(sample(p, "routy_requests_total", { status: "ok" })).toBe(2);
    expect(sample(p, "routy_requests_total", { status: "error" })).toBe(1);
    expect(sample(p, "routy_requests_by_node_total", { node: "a", status: "ok" })).toBe(2);
    expect(sample(p, "routy_tokens_total", { type: "prompt" })).toBe(16);
    expect(sample(p, "routy_tokens_total", { type: "completion" })).toBe(27);
    expect(sample(p, "routy_ttft_ms_count", { node: "a" })).toBe(2);
    expect(sample(p, "routy_ttft_ms_sum", { node: "a" })).toBe(100);
    expect(sample(p, "routy_ttft_ms_min", { node: "a" })).toBe(40);
    expect(sample(p, "routy_ttft_ms_max", { node: "a" })).toBe(60);
  });

  it("reports node and breaker state as gauges", () => {
    const healthy = repos.nodes.create({ name: "H", prefix: "h", apiType: "openai", baseUrl: "http://127.0.0.1:1/v1" });
    const down = repos.nodes.create({ name: "D", prefix: "d", apiType: "openai", baseUrl: "http://127.0.0.1:2/v1" });
    const off = repos.nodes.create({ name: "O", prefix: "o", apiType: "openai", baseUrl: "http://127.0.0.1:3/v1" });
    repos.nodes.update(off.id, { enabled: false });
    repos.breakers.record(`node:${down.id}`, { state: "open", openUntil: new Date(Date.now() + 60_000).toISOString(), failureDelta: 3 });
    repos.breakers.record(`node:${healthy.id}`, { failureDelta: 1 });

    const p = parse(renderMetrics(repos, { version: "0.1.0", inflight: 2 }));
    expect(sample(p, "routy_nodes", { status: "down" })).toBe(1);
    expect(sample(p, "routy_nodes", { status: "disabled" })).toBe(1);
    expect(sample(p, "routy_nodes", { status: "degraded" })).toBe(1);
    expect(sample(p, "routy_breaker_open", { scope: `node:${down.id}` })).toBe(1);
    expect(sample(p, "routy_breaker_failures", { scope: `node:${down.id}` })).toBe(3);
    expect(sample(p, "routy_inflight_requests")).toBe(2);
    expect(sample(p, "routy_build_info", { version: "0.1.0" })).toBe(1);
  });

  it("windowMs narrows the counters to recent events only", () => {
    repos.usage.record({ model: "old", status: "ok", ts: Date.now() - 3600_000 });
    repos.usage.record({ model: "new", status: "ok" });
    expect(sample(parse(renderMetrics(repos, { version: "0" })), "routy_requests_total", { status: "ok" })).toBe(2);
    expect(sample(parse(renderMetrics(repos, { version: "0", windowMs: 60_000 })), "routy_requests_total", { status: "ok" })).toBe(1);
  });

  it("always exposes live process gauges", () => {
    const p = parse(renderMetrics(repos, { version: "0.1.0" }));
    expect(sample(p, "routy_process_resident_memory_bytes")).toBeGreaterThan(0);
    expect(sample(p, "routy_process_heap_used_bytes")).toBeGreaterThan(0);
    expect(sample(p, "routy_process_external_bytes")).toBeGreaterThanOrEqual(0);
  });
});
