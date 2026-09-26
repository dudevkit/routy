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
  {
    // v5 — a pool holds many exits again, each with its own identity.
    //
    // v4 narrowed a pool to one URL so that a failure could name the proxy that failed.
    // That was the right unit for *health* and the wrong unit for the *container*: the
    // reason to keep several proxies is to multiply whatever the upstream meters per
    // address, and nobody wants fifty pools to do it. So exits (one URL each) become
    // rows and stay the health unit — `proxy:<entry id>:<node id>` in the breaker store —
    // while the pool goes back to being the fleet the user binds to a provider.
    //
    // Every existing pool keeps working: the data half gives it its single URL back as
    // its first exit, so bindings and rotation resolve to exactly what they did before.
    //
    // Pools that v4 split out of an old multi-URL pool stay split. There is no
    // provenance to rejoin them by, and guessing (name suffix plus config equality)
    // would as easily merge two pools the user meant to keep apart. The dashboard has a
    // merge action instead — an explicit act, on rows the user can see.
    version: 5,
    up: `
      CREATE TABLE proxy_pool_entries (
        id              TEXT PRIMARY KEY,
        pool_id         TEXT NOT NULL REFERENCES proxy_pools(id) ON DELETE CASCADE,
        url             TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        position        INTEGER NOT NULL DEFAULT 0,
        egress_ip       TEXT,
        last_tested_at  TEXT,
        last_test_ok    INTEGER,
        last_test_error TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE(pool_id, url)
      );
      CREATE INDEX idx_proxy_entries_pool ON proxy_pool_entries(pool_id, enabled);
    `,
    /** Data half of migration 5 — runs in the same transaction as `up`. */
    data(db) {
      const rows = db.prepare(`SELECT id, config, created_at FROM proxy_pools`).all();
      const insert = db.prepare(
        `INSERT INTO proxy_pool_entries (id, pool_id, url, enabled, position, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const row of rows) {
        let config = {};
        try { config = JSON.parse(row.config || "{}"); } catch { config = {}; }
        const url = typeof config.url === "string" ? config.url.trim() : "";
        if (!url) continue;
        insert.run(crypto.randomUUID(), row.id, url, row.created_at || now, now);
      }
    },
  },
];
