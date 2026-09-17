// RE-E schema v1 — mirrors docs/db-design.md §2.
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
];
