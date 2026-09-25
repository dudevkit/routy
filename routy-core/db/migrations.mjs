// routy schema v1 — mirrors docs/db-design.md §2.
import crypto from "node:crypto";

export const MIGRATIONS = [
  {
    version: 1,
    up: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE provider_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'openai-compatible',
        name TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        api_type TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL,
        data TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES provider_nodes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        credentials TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_connections_node ON connections(node_id, status, priority);

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        models TEXT NOT NULL,
        strategy TEXT NOT NULL DEFAULT 'fallback',
        sticky_limit INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE model_aliases (
        alias TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE proxy_pools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'static',
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE breakers (
        scope TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'closed',
        open_until TEXT,
        failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        node_id TEXT,
        connection_id TEXT,
        api_key_id TEXT,
        model TEXT,
        status TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cached_tokens INTEGER,
        cost_usd REAL,
        ttft_ms INTEGER,
        duration_ms INTEGER,
        error_code TEXT
      );
      CREATE INDEX idx_usage_ts ON usage_events(ts);
      CREATE INDEX idx_usage_node ON usage_events(node_id, ts);

      CREATE TABLE request_details (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        usage_event_id INTEGER,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_details_ts ON request_details(ts);
    `,
  },
  {
    // v2 — per-provider model list and per-key probe results.
    // Models move out of `provider_nodes.data` (a JSON string array that could not
    // carry per-model state) into their own rows, mirroring `connections`.
    version: 2,
    up: `
      CREATE TABLE node_models (
        id                TEXT PRIMARY KEY,
        node_id           TEXT NOT NULL REFERENCES provider_nodes(id) ON DELETE CASCADE,
        model             TEXT NOT NULL,
        source            TEXT NOT NULL DEFAULT 'manual',
        enabled           INTEGER NOT NULL DEFAULT 1,
        stale             INTEGER NOT NULL DEFAULT 0,
        last_test_at      TEXT,
        last_test_ok      INTEGER,
        last_test_ttft_ms INTEGER,
        last_test_error   TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        UNIQUE(node_id, model)
      );
      CREATE INDEX idx_node_models_node ON node_models(node_id, enabled);

      ALTER TABLE connections ADD COLUMN last_test_at TEXT;
      ALTER TABLE connections ADD COLUMN last_test_ok INTEGER;
      ALTER TABLE connections ADD COLUMN last_test_ttft_ms INTEGER;
    `,
  },
  {
    // v3 — keep client API keys readable from the dashboard.
    //
    // Keys were hash-only, so the plaintext existed for exactly one render and the
    // dashboard could never show it again. The dashboard *is* where these keys are
    // kept, so the value is stored alongside the hash: the hash still does the
    // lookup (verify stays an indexed equality match), the value is only ever
    // returned to the local management API. Rows created before this stay NULL.
    version: 3,
    up: `
      ALTER TABLE api_keys ADD COLUMN key_plain TEXT;
    `,
  },
  {
    // Proxy pools become one URL per pool, with a health verdict, so a pool can be
    // rotated against its siblings and can say which one failed. Pools created under
    // the old multi-URL shape are split into one pool per URL (see data below): the
    // config JSON cannot be reshaped in SQL, and silently keeping only the first URL
    // would drop proxies the user believed were in use.
    version: 4,
    up: `
      ALTER TABLE proxy_pools ADD COLUMN test_status TEXT;
      ALTER TABLE proxy_pools ADD COLUMN last_tested_at TEXT;
      ALTER TABLE proxy_pools ADD COLUMN last_error TEXT;
    `,
    /** Data half of migration 4 — runs in the same transaction as `up`. */
    data(db) {
      const rows = db.prepare(`SELECT * FROM proxy_pools`).all();
      const now = new Date().toISOString();
      const insert = db.prepare(
        `INSERT INTO proxy_pools (id, name, kind, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateConfig = db.prepare(`UPDATE proxy_pools SET config = ?, updated_at = ? WHERE id = ?`);

      for (const row of rows) {
        let config = {};
        try { config = JSON.parse(row.config || "{}"); } catch { config = {}; }
        if (typeof config.url === "string" && config.url.trim()) continue; // already fine

        const urls = Array.isArray(config.urls)
          ? config.urls.map((u) => (typeof u === "string" ? u : u?.url)).filter((u) => typeof u === "string" && u.trim())
          : [];
        if (urls.length === 0) continue;

        const { urls: _dropped, ...rest } = config;
        // the original pool keeps the first URL and keeps its identity (bindings point at it)
        updateConfig.run(JSON.stringify({ ...rest, url: urls[0].trim() }), now, row.id);
        for (let i = 1; i < urls.length; i++) {
          const id = crypto.randomUUID();
          insert.run(id, `${row.name} ${i + 1}`, row.kind, JSON.stringify({ ...rest, url: urls[i].trim() }), row.enabled, now, now);
        }
      }
    },
  },
];
