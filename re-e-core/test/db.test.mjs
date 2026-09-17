// P1.2 db layer tests — driver, repos, caching, batching, persistence.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";

let tmp;
let db;
let repos;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-db-"));
  db = openDatabase(tmp);
  repos = createRepos(db, { flushIntervalMs: 10, breakerFlushMs: 10 });
});

describe("driver", () => {
  it("creates schema and is idempotent on reopen", () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
    for (const t of ["settings", "provider_nodes", "connections", "api_keys", "combos", "model_aliases", "proxy_pools", "breakers", "usage_events", "request_details"]) {
      expect(tables).toContain(t);
    }
    const v1 = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
    expect(v1.value).toBe("1");
    db.close();
    const db2 = openDatabase(tmp); // must not throw or re-run v1
    const v2 = db2.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
    expect(v2.value).toBe("1");
    db2.close();
  });

  it("enables WAL journal mode", () => {
    const mode = db.prepare(`PRAGMA journal_mode`).get();
    expect(String(mode.journal_mode).toLowerCase()).toBe("wal");
  });
});

describe("settings", () => {
  it("returns empty then reflects updates (cache invalidated on write)", () => {
    expect(repos.settings.get("rtkEnabled")).toBeUndefined();
    repos.settings.update({ rtkEnabled: true, nested: { a: 1 } });
    expect(repos.settings.get("rtkEnabled")).toBe(true);
    expect(repos.settings.get("nested")).toEqual({ a: 1 });
  });
});

describe("nodes + connections", () => {
  it("roundtrips a node with cache coherence", () => {
    const node = repos.nodes.create({ name: "My Node", prefix: "mine", apiType: "openai", baseUrl: "http://127.0.0.1:9/v1" });
    expect(node.prefix).toBe("mine");
    expect(repos.nodes.byPrefix("mine").id).toBe(node.id);
    repos.nodes.update(node.id, { name: "Renamed" });
    expect(repos.nodes.byPrefix("mine").name).toBe("Renamed");
  });

  it("cascades connections on node delete", () => {
    const node = repos.nodes.create({ name: "N", prefix: "p1", baseUrl: "http://x/v1" });
    const conn = repos.connections.create({ nodeId: node.id, name: "key1", credentials: { apiKey: "k" } });
    expect(repos.connections.list(node.id)).toHaveLength(1);
    repos.nodes.delete(node.id);
    expect(repos.connections.get(conn.id)).toBeNull();
  });
});

describe("api keys", () => {
  it("creates, verifies, disables", () => {
    const { key, id } = repos.apiKeys.create("test");
    expect(key.startsWith("re_")).toBe(true);
    expect(repos.apiKeys.verify(key).id).toBe(id);
    expect(repos.apiKeys.verify("bogus")).toBeNull();
    repos.apiKeys.setEnabled(id, false);
    expect(repos.apiKeys.verify(key)).toBeNull();
  });
});

describe("usage batching", () => {
  it("auto-flushes at batch size and persists records", async () => {
    for (let i = 0; i < 60; i++) {
      repos.usage.record({ nodeId: "n1", model: "m", status: "ok", promptTokens: i, ttftMs: 5 });
    }
    expect(repos.usage.pending()).toBeLessThanOrEqual(10); // flushed at >=50
    repos.usage.flush();
    const rows = repos.usage.query({ nodeId: "n1", limit: 100 });
    expect(rows.length).toBe(60);
    expect(rows[0].prompt_tokens).toBe(59); // DESC order
  });
});

describe("breakers", () => {
  it("persists debounced state across reopen", async () => {
    repos.breakers.record("node:x", { state: "open", openUntil: new Date(Date.now() + 60000).toISOString(), failureDelta: 3, lastError: "boom" });
    await new Promise((r) => setTimeout(r, 30)); // debounce tick
    repos.close();
    db.close();
    const db2 = openDatabase(tmp);
    const repos2 = createRepos(db2);
    const b = repos2.breakers.get("node:x");
    expect(b.state).toBe("open");
    expect(b.failures).toBe(3);
    db2.close();
  });
});

describe("request details", () => {
  it("caps oversized content with truncated flag and purges old rows", () => {
    const big = { blob: "x".repeat(80 * 1024) };
    const saved = repos.requestDetails.save({ kind: "request", content: big });
    expect(saved.truncated).toBe(true);
    const listed = repos.requestDetails.list({ limit: 5 });
    expect(listed[0].truncated).toBe(true);
    expect(listed[0].content.length).toBeLessThanOrEqual(64 * 1024);
    const purged = repos.requestDetails.purge({ maxAgeDays: 0, maxRows: 50000 });
    expect(purged.aged).toBe(1);
  });
});
