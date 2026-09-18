// RE-E repos — data access over the driver with cache-on-read, invalidate-on-write.
// The only place SQL lives. Usage writes are batched off the hot path (db-design §4).
import crypto from "node:crypto";
import { createCacheLoader, createMapCache } from "./cache.mjs";
import { createApiKey } from "../lib/auth.mjs";

const uuid = () => crypto.randomUUID();
const DETAIL_CAP_BYTES = 64 * 1024;

export function createRepos(db, { flushIntervalMs = 250, flushBatchSize = 50, breakerFlushMs = 1000 } = {}) {
  // ── settings ──────────────────────────────────────────────────────────────
  const settingsCache = createCacheLoader(() => {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  });

  const settings = {
    all: () => ({ ...settingsCache.get() }),
    get: (key, fallback) => {
      const s = settingsCache.get();
      return key in s ? s[key] : fallback;
    },
    update(patch) {
      const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                               ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      const tx = db.transaction ? null : null; // node:sqlite has no db.transaction; manual below
      db.exec("BEGIN");
      try {
        for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
        db.exec("COMMIT");
      } catch (err) {
        throw err;
      }
      settingsCache.invalidate();
    },
  };

  // ── provider nodes ────────────────────────────────────────────────────────
  const nodesListCache = createCacheLoader(() =>
    db.prepare(`SELECT * FROM provider_nodes ORDER BY name`).all().map(rowToNode)
  );
  const nodeByIdCache = createMapCache();

  function rowToNode(r) {
    return {
      id: r.id, type: r.type, name: r.name, prefix: r.prefix,
      apiType: r.api_type, baseUrl: r.base_url,
      data: safeJson(r.data), enabled: !!r.enabled,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  const nodes = {
    list: (filter = {}) => {
      const all = nodesListCache.get();
      return filter.enabled === undefined ? all : all.filter((n) => n.enabled === filter.enabled);
    },
    byPrefix: (prefix) => nodes.list().find((n) => n.prefix === prefix) || null,
    get: (id) => {
      if (!nodeByIdCache.get(id)) {
        const row = db.prepare(`SELECT * FROM provider_nodes WHERE id = ?`).get(id);
        nodeByIdCache.set(id, row ? rowToNode(row) : null);
      }
      return nodeByIdCache.get(id);
    },
    create(input) {
      const now = new Date().toISOString();
      const node = {
        id: input.id || uuid(), type: input.type || "openai-compatible",
        name: input.name, prefix: input.prefix,
        apiType: input.apiType || "openai", baseUrl: input.baseUrl,
        data: input.data || null, enabled: input.enabled !== false,
      };
      db.prepare(`INSERT INTO provider_nodes (id, type, name, prefix, api_type, base_url, data, enabled, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(node.id, node.type, node.name, node.prefix, node.apiType, node.baseUrl,
             JSON.stringify(node.data), node.enabled ? 1 : 0, now, now);
      invalidateNodes();
      return nodes.get(node.id);
    },
    update(id, patch) {
      const existing = nodes.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      db.prepare(`UPDATE provider_nodes SET type=?, name=?, prefix=?, api_type=?, base_url=?, data=?, enabled=?, updated_at=? WHERE id=?`)
        .run(merged.type, merged.name, merged.prefix, merged.apiType, merged.baseUrl,
             JSON.stringify(merged.data), merged.enabled ? 1 : 0, merged.updatedAt, id);
      invalidateNodes();
      return nodes.get(id);
    },
    delete(id) {
      const info = db.prepare(`DELETE FROM provider_nodes WHERE id = ?`).run(id);
      invalidateNodes();
      return info.changes > 0;
    },
  };
  function invalidateNodes() { nodesListCache.invalidate(); nodeByIdCache.clear(); connections.invalidateCache(); }

  // ── connections (credentials per node/account) ────────────────────────────
  function rowToConnection(r) {
    return {
      id: r.id, nodeId: r.node_id, name: r.name,
      credentials: safeJson(r.credentials), status: r.status, lastError: r.last_error,
      priority: r.priority, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  const connections = {
    _cache: createMapCache(),
    invalidateCache() { this._cache.clear(); },
    list(nodeId) {
      if (!this._cache.get(nodeId)) {
        const rows = db.prepare(`SELECT * FROM connections WHERE node_id = ? ORDER BY priority, created_at`).all(nodeId);
        this._cache.set(nodeId, rows.map(rowToConnection));
      }
      return this._cache.get(nodeId);
    },
    get(id) {
      const row = db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
      return row ? rowToConnection(row) : null;
    },
    create(input) {
      const now = new Date().toISOString();
      const c = {
        id: input.id || uuid(), nodeId: input.nodeId, name: input.name,
        credentials: input.credentials || null, status: input.status || "active",
        priority: input.priority ?? 100,
      };
      db.prepare(`INSERT INTO connections (id, node_id, name, credentials, status, priority, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.id, c.nodeId, c.name, c.credentials ? JSON.stringify(c.credentials) : null,
             c.status, c.priority, now, now);
      connections.invalidateCache();
      return connections.get(c.id);
    },
    update(id, patch) {
      const existing = connections.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      db.prepare(`UPDATE connections SET name=?, credentials=?, status=?, last_error=?, priority=?, updated_at=? WHERE id=?`)
        .run(merged.name, merged.credentials ? JSON.stringify(merged.credentials) : null,
             merged.status, merged.lastError, merged.priority, merged.updatedAt, id);
      connections.invalidateCache();
      return connections.get(id);
    },
    delete(id) {
      const info = db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
      connections.invalidateCache();
      return info.changes > 0;
    },
  };

  // ── api keys (router client auth; stored hashed) ──────────────────────────
  const apiKeys = {
    list: () => db.prepare(`SELECT id, name, enabled, last_used_at AS lastUsedAt, created_at AS createdAt FROM api_keys ORDER BY created_at`).all()
      .map((r) => ({ ...r, enabled: !!r.enabled })),
    create(name) {
      const { key, hash } = createApiKey();
      const id = uuid();
      db.prepare(`INSERT INTO api_keys (id, key_hash, name, enabled, created_at) VALUES (?, ?, ?, 1, ?)`)
        .run(id, hash, name || null, new Date().toISOString());
      return { id, key, name }; // plaintext returned ONCE
    },
    verify(candidate) {
      if (typeof candidate !== "string" || !candidate) return null;
      const { hashKey } = authHelpers();
      const hash = hashKey(candidate);
      const row = db.prepare(`SELECT id, enabled FROM api_keys WHERE key_hash = ?`).get(hash);
      if (!row || !row.enabled) return null;
      db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
      return { id: row.id };
    },
    setEnabled(id, enabled) {
      return db.prepare(`UPDATE api_keys SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id).changes > 0;
    },
    delete(id) { return db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id).changes > 0; },
  };
  let _authHelpers = null;
  function authHelpers() {
    if (!_authHelpers) _authHelpers = { hashKey: (k) => crypto.createHash("sha256").update(k, "utf8").digest("hex") };
    return _authHelpers;
  }

  // ── combos + aliases (routing) ────────────────────────────────────────────
  const combosCache = createCacheLoader(() =>
    db.prepare(`SELECT * FROM combos`).all().map((r) => ({
      id: r.id, name: r.name, models: safeJson(r.models) || [],
      strategy: r.strategy, stickyLimit: r.sticky_limit, updatedAt: r.updated_at,
    }))
  );
  const aliasCache = createCacheLoader(() => {
    const out = {};
    for (const r of db.prepare(`SELECT alias, target FROM model_aliases`).all()) out[r.alias] = r.target;
    return out;
  });

  const combos = {
    list: () => combosCache.get(),
    byName: (name) => combosCache.get().find((c) => c.name === name) || null,
    create(input) {
      const now = new Date().toISOString();
      const id = input.id || uuid();
      db.prepare(`INSERT INTO combos (id, name, models, strategy, sticky_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, JSON.stringify(input.models || []), input.strategy || "fallback", input.stickyLimit ?? 1, now, now);
      combosCache.invalidate();
      return combos.byName(input.name);
    },
    update(id, patch) {
      const existing = combosCache.get().find((c) => c.id === id);
      if (!existing) return null;
      const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      db.prepare(`UPDATE combos SET name=?, models=?, strategy=?, sticky_limit=?, updated_at=? WHERE id=?`)
        .run(merged.name, JSON.stringify(merged.models), merged.strategy, merged.stickyLimit, merged.updatedAt, id);
      combosCache.invalidate();
      return combos.byName(merged.name);
    },
    delete(id) {
      const info = db.prepare(`DELETE FROM combos WHERE id = ?`).run(id);
      combosCache.invalidate();
      return info.changes > 0;
    },
  };

  const aliases = {
    map: () => aliasCache.get(),
    set(alias, target) {
      db.prepare(`INSERT INTO model_aliases (alias, target, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(alias) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`)
        .run(alias, target, new Date().toISOString());
      aliasCache.invalidate();
    },
    delete(alias) {
      const info = db.prepare(`DELETE FROM model_aliases WHERE alias = ?`).run(alias);
      aliasCache.invalidate();
      return info.changes > 0;
    },
  };

  // ── proxy pools ───────────────────────────────────────────────────────────
  const proxyPools = {
    list: () => db.prepare(`SELECT * FROM proxy_pools`).all().map(rowToPool),
    get: (id) => { const r = db.prepare(`SELECT * FROM proxy_pools WHERE id = ?`).get(id); return r ? rowToPool(r) : null; },
    create(input) {
      const now = new Date().toISOString();
      const id = input.id || uuid();
      db.prepare(`INSERT INTO proxy_pools (id, name, kind, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.kind || "static", JSON.stringify(input.config || {}), input.enabled !== false ? 1 : 0, now, now);
      return proxyPools.get(id);
    },
    update(id, patch) {
      const existing = proxyPools.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      db.prepare(`UPDATE proxy_pools SET name=?, kind=?, config=?, enabled=?, updated_at=? WHERE id=?`)
        .run(merged.name, merged.kind, JSON.stringify(merged.config), merged.enabled ? 1 : 0, merged.updatedAt, id);
      return proxyPools.get(id);
    },
    delete(id) { return db.prepare(`DELETE FROM proxy_pools WHERE id = ?`).run(id).changes > 0; },
  };
  function rowToPool(r) {
    return { id: r.id, name: r.name, kind: r.kind, config: safeJson(r.config), enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  // ── breakers (RAM-first, debounced persist) ───────────────────────────────
  const breakerRam = new Map();
  for (const r of db.prepare(`SELECT * FROM breakers`).all()) {
    breakerRam.set(r.scope, { scope: r.scope, state: r.state, openUntil: r.open_until, failures: r.failures, lastError: r.last_error, updatedAt: r.updated_at });
  }
  let breakerDirty = false;
  const breakerFlushTimer = setInterval(() => persistBreakers(), breakerFlushMs);
  breakerFlushTimer.unref?.();

  function persistBreakers() {
    if (!breakerDirty) return;
    breakerDirty = false;
    db.exec("BEGIN");
    try {
      const up = db.prepare(`INSERT INTO breakers (scope, state, open_until, failures, last_error, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?)
                             ON CONFLICT(scope) DO UPDATE SET state=excluded.state, open_until=excluded.open_until,
                               failures=excluded.failures, last_error=excluded.last_error, updated_at=excluded.updated_at`);
      for (const b of breakerRam.values()) {
        up.run(b.scope, b.state, b.openUntil, b.failures, b.lastError, b.updatedAt);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const breakers = {
    all: () => [...breakerRam.values()],
    get: (scope) => breakerRam.get(scope) || null,
    record(scope, { state, openUntil = null, failureDelta = 0, lastError = null }) {
      const cur = breakerRam.get(scope) || { scope, state: "closed", openUntil: null, failures: 0, lastError: null, updatedAt: "" };
      const next = {
        ...cur,
        state: state || cur.state,
        openUntil: openUntil ?? cur.openUntil,
        failures: Math.max(0, cur.failures + failureDelta),
        lastError: lastError ?? cur.lastError,
        updatedAt: new Date().toISOString(),
      };
      breakerRam.set(scope, next);
      breakerDirty = true;
      return next;
    },
    flush: persistBreakers,
  };

  // ── usage (write-behind queue) ────────────────────────────────────────────
  const usageQueue = [];
  const usageStmt = () => db.prepare(`INSERT INTO usage_events (ts, node_id, connection_id, api_key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, cost_usd, ttft_ms, duration_ms, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  function flushUsage() {
    if (usageQueue.length === 0) return 0;
    const batch = usageQueue.splice(0, usageQueue.length);
    const stmt = usageStmt();
    db.exec("BEGIN");
    try {
      for (const u of batch) {
        stmt.run(u.ts ?? Date.now(), u.nodeId ?? null, u.connectionId ?? null, u.apiKeyId ?? null,
                 u.model ?? null, u.status ?? null,
                 u.promptTokens ?? null, u.completionTokens ?? null, u.cachedTokens ?? null,
                 u.costUsd ?? null, u.ttftMs ?? null, u.durationMs ?? null, u.errorCode ?? null);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      // re-queue: losing usage is worse than delaying it
      usageQueue.unshift(...batch);
      throw err;
    }
    return batch.length;
  }
  const usageFlushTimer = setInterval(() => {
    try { flushUsage(); } catch (err) { /* retried next tick; logged by caller if needed */ }
  }, flushIntervalMs);
  usageFlushTimer.unref?.();

  const usage = {
    record(ev) {
      usageQueue.push({ ts: ev.ts ?? Date.now(), ...ev });
      if (usageQueue.length >= flushBatchSize) flushUsage();
    },
    flush: flushUsage,
    pending: () => usageQueue.length,
    query: ({ since, until, nodeId, limit = 1000 } = {}) => {
      const where = [];
      const params = [];
      if (since) { where.push("ts >= ?"); params.push(since); }
      if (until) { where.push("ts <= ?"); params.push(until); }
      if (nodeId) { where.push("node_id = ?"); params.push(nodeId); }
      const sql = `SELECT * FROM usage_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`;
      params.push(limit);
      return db.prepare(sql).all(...params);
    },
  };

  // ── request details (size-capped, retention-purged) ───────────────────────
  const requestDetails = {
    save({ usageEventId = null, kind, content }) {
      let text = typeof content === "string" ? content : JSON.stringify(content);
      const truncated = Buffer.byteLength(text, "utf8") > DETAIL_CAP_BYTES;
      if (truncated) text = text.slice(0, DETAIL_CAP_BYTES);
      const info = db.prepare(`INSERT INTO request_details (ts, usage_event_id, kind, content, truncated) VALUES (?, ?, ?, ?, ?)`)
        .run(Date.now(), usageEventId, kind, text, truncated ? 1 : 0);
      return { id: Number(info.lastInsertRowid), truncated };
    },
    list: ({ since, usageEventId, limit = 100 } = {}) => {
      const where = [];
      const params = [];
      if (since) { where.push("ts >= ?"); params.push(since); }
      if (usageEventId) { where.push("usage_event_id = ?"); params.push(usageEventId); }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT id, ts, usage_event_id AS usageEventId, kind, truncated, content FROM request_details ${whereSql} ORDER BY id DESC LIMIT ?`)
        .all(...params, limit);
      return rows.map((r) => ({ ...r, truncated: !!r.truncated }));
    },
    purge({ maxAgeDays = 7, maxRows = 50000 } = {}) {
      const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
      const aged = db.prepare(`DELETE FROM request_details WHERE ts < ?`).run(cutoff).changes;
      const capped = db.prepare(`DELETE FROM request_details WHERE id NOT IN (SELECT id FROM request_details ORDER BY id DESC LIMIT ?)`).run(maxRows).changes;
      return { aged, capped };
    },
  };

  return {
    settings, nodes, connections, apiKeys, combos, aliases, proxyPools, breakers, usage, requestDetails,
    close() {
      clearInterval(usageFlushTimer);
      clearInterval(breakerFlushTimer);
      flushUsage();
      persistBreakers();
    },
  };
}

function safeJson(text) {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
}
