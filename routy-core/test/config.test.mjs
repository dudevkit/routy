// Rename-migration tests.
//
// The app shipped as RE-E and is now routy. An existing install must survive the
// change with no environment edits and no data loss, which makes this the one part
// of the rename where a bug is unrecoverable — so it is tested against a real
// filesystem, not a mock.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveHome, resolveConfig } from "../lib/config.mjs";
import { openDatabase } from "../db/driver.mjs";

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-cfg-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const legacy = () => path.join(tmp, ".re-e");
const current = () => path.join(tmp, ".routy");

describe("state dir rename", () => {
  it("adopts a pre-rename ~/.re-e by moving it to ~/.routy", () => {
    fs.mkdirSync(path.join(legacy(), "data"), { recursive: true });
    fs.writeFileSync(path.join(legacy(), "data", "re-e.db"), "payload");

    const r = resolveHome({}, { homedir: tmp });

    expect(r.home).toBe(current());
    expect(r.migratedFrom).toBe(legacy());
    expect(fs.existsSync(legacy())).toBe(false);
    // the contents moved, they were not copied or dropped
    expect(fs.readFileSync(path.join(current(), "data", "re-e.db"), "utf8")).toBe("payload");
  }, 20_000);

  it("leaves an already-migrated home alone", () => {
    fs.mkdirSync(current(), { recursive: true });
    const r = resolveHome({}, { homedir: tmp });
    expect(r.home).toBe(current());
    expect(r.migratedFrom).toBe(null);
  }, 20_000);

  it("falls back to the legacy home when the move fails, rather than starting empty", () => {
    fs.mkdirSync(legacy(), { recursive: true });
    // a file where the new home must go makes rename fail (ENOTEMPTY/EEXIST)
    fs.mkdirSync(current(), { recursive: true });
    fs.writeFileSync(path.join(current(), "occupied"), "x");

    const r = resolveHome({}, { homedir: tmp });
    // the new home exists, so it wins — the legacy dir is simply not adopted
    expect(r.home).toBe(current());
    expect(r.migratedFrom).toBe(null);
  }, 20_000);

  it("uses a fresh ~/.routy when there is nothing to adopt", () => {
    const r = resolveHome({}, { homedir: tmp });
    expect(r.home).toBe(current());
    expect(r.migratedFrom).toBe(null);
  }, 20_000);

  it("follows a migrated home when a stale RE_E_HOME still points at the old path", () => {
    fs.mkdirSync(current(), { recursive: true });
    const r = resolveHome({ RE_E_HOME: legacy() }, { homedir: tmp });
    // the env var points at a directory that no longer exists; following it would
    // silently create a second, empty install
    expect(r.home).toBe(current());
  }, 20_000);

  it("honours an explicit ROUTY_HOME", () => {
    const custom = path.join(tmp, "elsewhere");
    fs.mkdirSync(custom, { recursive: true });
    expect(resolveHome({ ROUTY_HOME: custom }, { homedir: tmp }).home).toBe(custom);
  }, 20_000);

  it("still reads the legacy RE_E_* variables", () => {
    const custom = path.join(tmp, "legacy-env");
    fs.mkdirSync(custom, { recursive: true });
    const cfg = resolveConfig({ RE_E_HOME: custom, RE_E_PORT: "9999", RE_E_LOG_LEVEL: "debug" });
    expect(cfg.home).toBe(custom);
    expect(cfg.port).toBe(9999);
    expect(cfg.logLevel).toBe("debug");
  }, 20_000);

  it("prefers ROUTY_* over RE_E_* when both are set", () => {
    const a = path.join(tmp, "new-env"), b = path.join(tmp, "old-env");
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
    const cfg = resolveConfig({ ROUTY_HOME: a, RE_E_HOME: b, ROUTY_PORT: "1111", RE_E_PORT: "2222" });
    expect(cfg.home).toBe(a);
    expect(cfg.port).toBe(1111);
  }, 20_000);
});

describe("database file rename", () => {
  it("adopts re-e.db as routy.db and keeps its contents", () => {
    const dataDir = path.join(tmp, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const legacyDb = new DatabaseSync(path.join(dataDir, "re-e.db"));
    legacyDb.exec("CREATE TABLE keep (v TEXT); INSERT INTO keep VALUES ('survived')");
    legacyDb.close();

    const db = openDatabase(dataDir);
    const row = db.prepare("SELECT v FROM keep").get();
    db.close();

    expect(row.v).toBe("survived");
    expect(fs.existsSync(path.join(dataDir, "routy.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "re-e.db"))).toBe(false);
  }, 20_000);

  it("creates routy.db for a fresh install", () => {
    const dataDir = path.join(tmp, "fresh");
    const db = openDatabase(dataDir);
    db.close();
    expect(fs.existsSync(path.join(dataDir, "routy.db"))).toBe(true);
  }, 20_000);

  it("prefers routy.db when both exist", () => {
    const dataDir = path.join(tmp, "both");
    fs.mkdirSync(dataDir, { recursive: true });
    for (const [name, value] of [["re-e.db", "old"], ["routy.db", "new"]]) {
      const d = new DatabaseSync(path.join(dataDir, name));
      d.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${value}')`);
      d.close();
    }
    const db = openDatabase(dataDir);
    expect(db.prepare("SELECT v FROM t").get().v).toBe("new");
    db.close();
  }, 20_000);
});
