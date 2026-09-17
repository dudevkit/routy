# RE-E DB Design

> SQLite via `node:sqlite` (builtin, Node ≥22.5). Replaces upstream's 4-driver chain
> (`9router/src/lib/db/driver.js`). Companion: [backend-architecture.md](./backend-architecture.md).

## 1. Driver strategy

| Decision | Choice | Why |
|---|---|---|
| Driver | `node:sqlite` builtin | Kills better-sqlite3 native builds (upstream's Windows EBUSY + Node-24 SIGSEGV history), zero deps |
| Journal | WAL + `busy_timeout=5000` | Readers never block the proxy; crash-safe |
| Connections | One handle, process-wide | Single writer; sync API is fine at our scale if writes are batched (§4) |
| Adapter seam | Keep a thin `driver.mjs` interface (all/run/transaction) | Escape hatch to better-sqlite3 is one file if node:sqlite gaps appear |
| Migrations | `meta.schema_version` + forward-only `migrations/NNN_*.js` | Port of upstream's `migrate.js` pattern, simplified |
| Fallback drivers (bun/better/sql.js) | **Deleted** | One supported runtime; machine-independent behavior |

## 2. Schema v1

```sql
CREATE TABLE meta            (key TEXT PRIMARY KEY, value TEXT);            -- schema_version, machine_id
CREATE TABLE settings        (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- value = JSON
CREATE TABLE provider_nodes  (
  id TEXT PRIMARY KEY, type TEXT, name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE,
  api_type TEXT NOT NULL DEFAULT 'openai',        -- 'openai' | 'anthropic'
  base_url TEXT NOT NULL, data TEXT,               -- JSON: headers, modelsFetch, retry overrides
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE TABLE connections     (
  id TEXT PRIMARY KEY, node_id TEXT REFERENCES provider_nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL, credentials TEXT,            -- JSON (plaintext v1; §5)
  status TEXT NOT NULL DEFAULT 'active',           -- active | error | disabled
  last_error TEXT, priority INTEGER DEFAULT 100,   -- fallback order within node
  created_at TEXT, updated_at TEXT);
CREATE TABLE api_keys        (
  id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, last_used_at TEXT, created_at TEXT);
CREATE TABLE combos          (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, models TEXT NOT NULL, -- JSON: [nodePrefix/model, ...]
  strategy TEXT NOT NULL DEFAULT 'fallback',       -- fallback | round-robin
  sticky_limit INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE TABLE model_aliases   (alias TEXT PRIMARY KEY, target TEXT NOT NULL, updated_at TEXT);
CREATE TABLE proxy_pools     (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'static',
  config TEXT NOT NULL,                            -- JSON: {urls:[...], healthcheck, auth}
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE TABLE breakers        (                                              -- persisted circuit state
  scope TEXT PRIMARY KEY,                          -- nodeId | nodeId:model | combo:name
  state TEXT NOT NULL DEFAULT 'closed',            -- closed | open | half_open
  open_until TEXT, failures INTEGER DEFAULT 0, last_error TEXT, updated_at TEXT);
CREATE TABLE usage_events    (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, node_id TEXT, connection_id TEXT,
  api_key_id TEXT, model TEXT, status TEXT,        -- ok | error | aborted
  prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER,
  cost_usd REAL, ttft_ms INTEGER, duration_ms INTEGER,
  error_code TEXT);
CREATE INDEX idx_usage_ts    ON usage_events(ts);
CREATE INDEX idx_usage_node  ON usage_events(node_id, ts);
CREATE TABLE request_details (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, usage_event_id INTEGER,
  kind TEXT NOT NULL,                              -- request | response | error
  content TEXT NOT NULL,                           -- JSON, size-capped (§4)
  truncated INTEGER DEFAULT 0);
CREATE INDEX idx_details_ts  ON request_details(ts);
```

Notes:
- `settings` keys mirror upstream's settings shape (rtkEnabled, requireApiKey, combos
  strategy defaults, …) so the existing dashboard finds familiar payloads.
- One `connections` row per API key/account; a node can have many (upstream's
  multi-account fallback), each with `priority`.
- `combos` reference `nodePrefix/model` — same string clients send.
- No `pricing` table v1: cost comes from per-node `data.pricing` overrides + generic
  fallback table shipped as a static JS module (upstream's pricing DB is a data file, not logic).

## 3. Cache layer (new — upstream has none)

```
db/cache.mjs:  get(key) / invalidate(key|'*')
  - settings: full-object cache, TTL ∞, invalidated on updateSettings
  - nodes+connections: Map cache, invalidated on any repo write
  - per-request reads hit memory; SQLite touched only on first read or after write
```

Removes upstream's 2–3 uncached `getSettings()` SQLite reads per request
(`9router/src/sse/handlers/chat.js:70,266`) and per-attempt credential reads.

## 4. Write discipline (event loop protection)

| Concern | Upstream | RE-E |
|---|---|---|
| Usage event per request | sync insert mid-stream | queue + flush every 250ms or 50 events; usage `SELECT`s hit the same WAL db without blocking readers |
| Request detail blobs | full raw bodies | cap 64KB per blob, truncate flag, retention: 7 days + 50k rows (configurable), eviction on flush |
| Breaker updates | RAM only | RAM first, WAL write-through debounced 1s (survives restart) |
| Credentials write | per-refresh | immediate (rare, must not lose tokens) |

## 5. Secrets

v1: credentials JSON plaintext (upstream parity, local file, single-user tool).
P3: OS-protected at-rest via one `secrets.mjs` interface — DPAPI (Windows) /
libsecret (Linux) / Keychain (macOS), key-material never logged. Hashed `api_keys`
already avoid storing router client keys.

## 6. Backup / export

`POST /api/export` → single JSON (settings, nodes, connections[+secrets], combos,
aliases, pools) for migration/backup; `POST /api/import` merges by id. Replaces
upstream's cloud-sync need for single-machine users.
