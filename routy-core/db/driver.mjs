// routy db driver — node:sqlite (builtin), WAL, forward-only migrations.
// Single writer connection; readers never blocked (WAL). Escape hatch to
// better-sqlite3 is this one file if node:sqlite gaps appear (db-design §1).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations.mjs";

const DB_FILE = "routy.db";
// Deliberate legacy spelling — this is the file an install created before the
// rename, and the whole point of adoptLegacyDatabase is to find and move it.
const LEGACY_DB_FILE = "re-e.db";

/**
 * Adopt a pre-rename database. WAL keeps its state in sidecar files, so they move
 * with it — a db renamed without its -wal would lose whatever has not been
 * checkpointed. If the rename fails (a running gateway holds the file open) the
 * legacy file is used in place rather than creating an empty database beside it.
 */
function adoptLegacyDatabase(dataDir) {
  const target = path.join(dataDir, DB_FILE);
  const legacy = path.join(dataDir, LEGACY_DB_FILE);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return target;
  try {
    fs.renameSync(legacy, target);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, target + suffix);
    }
    return target;
  } catch {
    return legacy;
  }
}

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = adoptLegacyDatabase(dataDir);
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  const current = row ? parseInt(row.value, 10) : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.up);
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(m.version));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration v${m.version} failed: ${err.message}`);
    }
  }
}

export function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
