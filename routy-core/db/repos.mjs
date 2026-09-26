// routy repos — data access over the driver with cache-on-read, invalidate-on-write.
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
    /**
     * `data` is a bag of independent settings (pricing, pool tuning, cached model
     * list, retry overrides), so a patch MERGES into it instead of replacing it —
     * editing one field must not silently drop the others.
     */
    update(id, patch) {
      const existing = nodes.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      if (patch.data !== undefined) merged.data = { ...(existing.data || {}), ...patch.data };
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
  function invalidateNodes() { nodesListCache.invalidate(); nodeByIdCache.clear(); connections.invalidateCache(); nodeModels.invalidateCache(); }

  // ── connections (credentials per node/account) ────────────────────────────
  function rowToConnection(r) {
    return {
      id: r.id, nodeId: r.node_id, name: r.name,
      credentials: safeJson(r.credentials), status: r.status, lastError: r.last_error,
      priority: r.priority, createdAt: r.created_at, updatedAt: r.updated_at,
      // probe results (P6): diagnostics only — never derived from real traffic
      lastTestAt: r.last_test_at, lastTestOk: r.last_test_ok === null ? null : !!r.last_test_ok,
      lastTestTtftMs: r.last_test_ttft_ms,
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
      db.prepare(`UPDATE connections SET name=?, credentials=?, status=?, last_error=?, priority=?,
                    last_test_at=?, last_test_ok=?, last_test_ttft_ms=?, updated_at=? WHERE id=?`)
        .run(merged.name, merged.credentials ? JSON.stringify(merged.credentials) : null,
             merged.status, merged.lastError, merged.priority,
             merged.lastTestAt ?? null, merged.lastTestOk === null || merged.lastTestOk === undefined ? null : (merged.lastTestOk ? 1 : 0),
             merged.lastTestTtftMs ?? null, merged.updatedAt, id);
      connections.invalidateCache();
      return connections.get(id);
    },
    /** Record a probe outcome on the key itself (P6). Diagnostics, not traffic. */
    recordTest(id, { ok, latencyMs = null, ttftMs = null, error = null }) {
      const existing = connections.get(id);
      if (!existing) return null;
      db.prepare(`UPDATE connections SET last_test_at=?, last_test_ok=?, last_test_ttft_ms=?, last_error=?, updated_at=? WHERE id=?`)
        .run(new Date().toISOString(), ok ? 1 : 0, ttftMs ?? latencyMs ?? null, error, new Date().toISOString(), id);
      connections.invalidateCache();
      return connections.get(id);
    },
    /** Drop every stored key-probe verdict (see nodeModels.clearTestResults). */
    clearTestResults() {
      const changed = db.prepare(`UPDATE connections SET last_test_at=NULL, last_test_ok=NULL, last_test_ttft_ms=NULL, last_error=NULL WHERE last_test_at IS NOT NULL`).run().changes;
      connections.invalidateCache();
      return changed;
    },
    delete(id) {
      const info = db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
      connections.invalidateCache();
      return info.changes > 0;
    },
  };

  // ── node models (per-provider model list; P6) ─────────────────────────────
  // One row per model so it can carry its own state: where it came from, whether
  // it is enabled, whether upstream still lists it, and its last probe result.
  // `enabled` only affects discovery (`/v1/models`) — routing passes through.
  function rowToModel(r) {
    return {
      id: r.id, nodeId: r.node_id, model: r.model,
      source: r.source, enabled: !!r.enabled, stale: !!r.stale,
      lastTestAt: r.last_test_at, lastTestOk: r.last_test_ok === null ? null : !!r.last_test_ok,
      lastTestTtftMs: r.last_test_ttft_ms, lastTestError: r.last_test_error,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  const nodeModels = {
    _cache: createMapCache(),
    invalidateCache() { this._cache.clear(); },
    /** All rows for a node, enabled first then alphabetical. */
    list(nodeId) {
      if (!this._cache.get(nodeId)) {
        const rows = db.prepare(`SELECT * FROM node_models WHERE node_id = ? ORDER BY stale, model`).all(nodeId);
        this._cache.set(nodeId, rows.map(rowToModel));
      }
      return this._cache.get(nodeId);
    },
    /** Enabled, non-stale model ids — what discovery exposes. */
    enabledModels(nodeId) {
      return nodeModels.list(nodeId).filter((m) => m.enabled && !m.stale).map((m) => m.model);
    },
    get(id) {
      const row = db.prepare(`SELECT * FROM node_models WHERE id = ?`).get(id);
      return row ? rowToModel(row) : null;
    },
    byModel(nodeId, model) {
      const row = db.prepare(`SELECT * FROM node_models WHERE node_id = ? AND model = ?`).get(nodeId, model);
      return row ? rowToModel(row) : null;
    },
    /** Add a model by hand. Re-adding an existing id re-enables it rather than failing. */
    create({ nodeId, model, enabled = true, source = "manual" }) {
      const existing = nodeModels.byModel(nodeId, model);
      if (existing) return nodeModels.update(existing.id, { enabled, stale: false });
      const now = new Date().toISOString();
      const id = uuid();
      db.prepare(`INSERT INTO node_models (id, node_id, model, source, enabled, stale, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(id, nodeId, model, source, enabled ? 1 : 0, now, now);
      nodeModels.invalidateCache();
      return nodeModels.get(id);
    },
    update(id, patch) {
      const existing = nodeModels.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      db.prepare(`UPDATE node_models SET model=?, source=?, enabled=?, stale=?, updated_at=? WHERE id=?`)
        .run(merged.model, merged.source, merged.enabled ? 1 : 0, merged.stale ? 1 : 0, new Date().toISOString(), id);
      nodeModels.invalidateCache();
      return nodeModels.get(id);
    },
    recordTest(id, { ok, ttftMs = null, error = null }) {
      const existing = nodeModels.get(id);
      if (!existing) return null;
      db.prepare(`UPDATE node_models SET last_test_at=?, last_test_ok=?, last_test_ttft_ms=?, last_test_error=?, updated_at=? WHERE id=?`)
        .run(new Date().toISOString(), ok ? 1 : 0, ttftMs, error, new Date().toISOString(), id);
      nodeModels.invalidateCache();
      return nodeModels.get(id);
    },
    /**
     * Drop every stored probe verdict. Used when probe semantics change, so a
     * result the current code could never produce stops being displayed as current.
     * Returns how many rows were cleared.
     */
    clearTestResults() {
      const changed = db.prepare(`UPDATE node_models SET last_test_at=NULL, last_test_ok=NULL, last_test_ttft_ms=NULL, last_test_error=NULL WHERE last_test_at IS NOT NULL`).run().changes;
      nodeModels.invalidateCache();
      return changed;
    },
    delete(id) {
      const info = db.prepare(`DELETE FROM node_models WHERE id = ?`).run(id);
      nodeModels.invalidateCache();
      return info.changes > 0;
    },
    /** Bulk enable/disable. Scoped by node so an id from elsewhere is a no-op. */
    setEnabledMany(nodeId, ids, enabled) {
      if (!ids.length) return 0;
      let changed = 0;
      for (const chunk of chunksOf(ids, 200)) {
        const marks = chunk.map(() => "?").join(",");
        changed += db.prepare(`UPDATE node_models SET enabled=?, updated_at=? WHERE node_id=? AND id IN (${marks})`)
          .run(enabled ? 1 : 0, new Date().toISOString(), nodeId, ...chunk).changes;
      }
      nodeModels.invalidateCache();
      return changed;
    },
    /** Bulk delete. Same node scoping. */
    deleteMany(nodeId, ids) {
      if (!ids.length) return 0;
      let changed = 0;
      for (const chunk of chunksOf(ids, 200)) {
        const marks = chunk.map(() => "?").join(",");
        changed += db.prepare(`DELETE FROM node_models WHERE node_id=? AND id IN (${marks})`).run(nodeId, ...chunk).changes;
      }
      nodeModels.invalidateCache();
      return changed;
    },
    /**
     * Merge an upstream model list into a node's rows.
     * Manual rows are never touched. Imported rows are upserted; previously
     * imported rows missing from `models` become `stale` (visible, disabled) and
     * are never deleted. Rows that reappear have `stale` cleared.
     */
    import(nodeId, models) {
      const now = new Date().toISOString();
      const incoming = new Set(models.filter((m) => typeof m === "string" && m.length > 0));
      const before = nodeModels.list(nodeId);
      let imported = 0, kept = 0, stale = 0;

      const upsert = db.prepare(`INSERT INTO node_models (id, node_id, model, source, enabled, stale, created_at, updated_at)
                                 VALUES (?, ?, ?, 'imported', 1, 0, ?, ?)
                                 ON CONFLICT(node_id, model) DO UPDATE SET stale = 0, updated_at = excluded.updated_at`);
      const markStale = db.prepare(`UPDATE node_models SET stale = 1, updated_at = ? WHERE id = ?`);

      db.exec("BEGIN");
      try {
        for (const model of incoming) upsert.run(uuid(), nodeId, model, now, now);
        for (const row of before) {
          if (row.source !== "imported") { kept++; continue; }
          if (incoming.has(row.model)) continue;
          if (!row.stale) { markStale.run(now, row.id); stale++; }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      imported = incoming.size;
      nodeModels.invalidateCache();
      return { imported, kept, stale };
    },
    /** One-time lift of the legacy `data.models` JSON array into rows. */
    backfill(nodeId, models) {
      if (!Array.isArray(models) || models.length === 0) return 0;
      const existing = nodeModels.list(nodeId);
      if (existing.length > 0) return 0;
      let n = 0;
      for (const model of models) {
        if (typeof model !== "string" || !model) continue;
        nodeModels.create({ nodeId, model, source: "imported", enabled: true });
        n++;
      }
      return n;
    },
  };

  // ── api keys (router client auth) ─────────────────────────────────────────
  // Lookup is by hash (an indexed equality match, no scan, no timing signal);
  // the plaintext is kept only so the dashboard can hand the key back later.
  const apiKeys = {
    list: () => db.prepare(`SELECT id, name, enabled, key_plain AS key, last_used_at AS lastUsedAt, created_at AS createdAt FROM api_keys ORDER BY created_at`).all()
      .map((r) => ({ ...r, enabled: !!r.enabled })),
    create(name) {
      const { key, hash } = createApiKey();
      const id = uuid();
      db.prepare(`INSERT INTO api_keys (id, key_hash, key_plain, name, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
        .run(id, hash, key, name || null, new Date().toISOString());
      return { id, key, name };
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
    /** Record a health-check verdict on the pool (see core/proxy.mjs testProxyUrl). */
    recordTest(id, { ok, error = null }) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE proxy_pools SET test_status=?, last_tested_at=?, last_error=?, updated_at=? WHERE id=?`)
        .run(ok ? "active" : "error", now, ok ? null : (error || "failed").slice(0, 200), now, id);
      return proxyPools.get(id);
    },
    /**
     * Merge pools into one: exits move to the target and every binding that pointed at an
     * absorbed pool is rewritten to point at the target (see `rebindPools`).
     *
     * All of it runs in one transaction, bindings included: a half-applied merge would
     * leave a node naming a pool that no longer exists, and that resolves to a direct
     * request rather than an error.
     */
    merge(targetId, sourceIds = []) {
      const target = proxyPools.get(targetId);
      if (!target) return null;
      const sources = [...new Set(sourceIds)].filter((id) => id && id !== targetId && proxyPools.get(id));
      if (sources.length === 0) return target;

      const dropDuplicates = db.prepare(
        `DELETE FROM proxy_pool_entries WHERE pool_id = ? AND url IN (SELECT url FROM proxy_pool_entries WHERE pool_id = ?)`,
      );
      const absorb = db.prepare(`UPDATE proxy_pool_entries SET pool_id = ?, updated_at = ? WHERE pool_id = ?`);
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        for (const id of sources) {
          // The same address in both pools would violate UNIQUE(pool_id, url); keeping the
          // target's row also keeps whatever health verdict that row had earned.
          dropDuplicates.run(id, targetId);
          absorb.run(targetId, now, id);
          db.prepare(`DELETE FROM proxy_pools WHERE id = ?`).run(id);
        }
        rebindPools(targetId, sources);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return proxyPools.get(targetId);
    },
    delete(id) { return db.prepare(`DELETE FROM proxy_pools WHERE id = ?`).run(id).changes > 0; },
  };
  function rowToPool(r) {
    const config = safeJson(r.config) || {};
    // A pool written before migration 4 holds `urls: [...]`. Migration 4 splits those
    // into one pool per URL; this keeps a read working for anything that slips through
    // (an older row in a database restored from backup, a pool created by an old API
    // call in the same process).
    if (typeof config.url !== "string" && Array.isArray(config.urls)) {
      const first = config.urls.map((u) => (typeof u === "string" ? u : u?.url)).find((u) => typeof u === "string" && u.trim());
      if (first) config.url = first.trim();
    }
    return {
      id: r.id, name: r.name, kind: r.kind, config, enabled: !!r.enabled,
      testStatus: r.test_status ?? null,
      lastTestedAt: r.last_tested_at ?? null,
      lastError: r.last_error ?? null,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  // ── proxy pool entries — one URL each, and the rotation/health unit ───────
  function rowToEntry(r) {
    return {
      id: r.id, poolId: r.pool_id, url: r.url, enabled: !!r.enabled, position: r.position,
      egressIp: r.egress_ip ?? null,
      lastTestedAt: r.last_tested_at ?? null,
      lastTestOk: r.last_test_ok === null || r.last_test_ok === undefined ? null : !!r.last_test_ok,
      lastTestError: r.last_test_error ?? null,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  const proxyPoolEntries = {
    listByPool: (poolId) =>
      db.prepare(`SELECT * FROM proxy_pool_entries WHERE pool_id = ? ORDER BY position, created_at`).all(poolId).map(rowToEntry),
    get: (id) => {
      const r = db.prepare(`SELECT * FROM proxy_pool_entries WHERE id = ?`).get(id);
      return r ? rowToEntry(r) : null;
    },
    /**
     * Add exits to a pool. A URL already in the pool is skipped rather than refused: the
     * dashboard's paste box is meant to be pasted into twice, and "already there" is an
     * answer, not a failure. Returns the rows actually added.
     */
    addMany(poolId, urls = []) {
      const existing = new Set(proxyPoolEntries.listByPool(poolId).map((e) => e.url));
      const insert = db.prepare(
        `INSERT INTO proxy_pool_entries (id, pool_id, url, enabled, position, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      let position = existing.size;
      const added = [];
      db.exec("BEGIN");
      try {
        for (const raw of urls) {
          const url = typeof raw === "string" ? raw.trim() : "";
          if (!url || existing.has(url)) continue;
          const id = uuid();
          insert.run(id, poolId, url, position++, now, now);
          existing.add(url);
          added.push(id);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return added.map((id) => proxyPoolEntries.get(id));
    },
    update(id, patch = {}) {
      const existing = proxyPoolEntries.get(id);
      if (!existing) return null;
      // A changed URL is a different exit: the old verdict and egress address describe the
      // address it replaced, so they go with it instead of being shown against the new one.
      const next = typeof patch.url === "string" && patch.url.trim() ? patch.url.trim() : existing.url;
      const urlChanged = next !== existing.url;
      const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled !== false;
      const now = new Date().toISOString();
      db.prepare(`UPDATE proxy_pool_entries SET url=?, enabled=?, updated_at=? WHERE id=?`).run(next, enabled ? 1 : 0, now, id);
      if (urlChanged) {
        db.prepare(`UPDATE proxy_pool_entries SET egress_ip=NULL, last_tested_at=NULL, last_test_ok=NULL, last_test_error=NULL WHERE id=?`).run(id);
      }
      return proxyPoolEntries.get(id);
    },
    /** Record a check verdict, including the address the proxy appeared as upstream. */
    recordTest(id, { ok, error = null, egressIp = null }) {
      const now = new Date().toISOString();
      // COALESCE: a check that could not report an address (custom testUrl, failed probe)
      // must not erase the last address we did learn — the fleet's IP count is built from it.
      db.prepare(
        `UPDATE proxy_pool_entries SET last_tested_at=?, last_test_ok=?, last_test_error=?, egress_ip=COALESCE(?, egress_ip), updated_at=? WHERE id=?`,
      ).run(now, ok ? 1 : 0, ok ? null : String(error || "failed").slice(0, 200), egressIp, now, id);
      return proxyPoolEntries.get(id);
    },
    delete(id) { return db.prepare(`DELETE FROM proxy_pool_entries WHERE id = ?`).run(id).changes > 0; },
    countAll: () => db.prepare(`SELECT COUNT(*) AS n FROM proxy_pool_entries`).get().n,
  };

  /**
   * Point every binding at `targetId` that used to point at one of `absorbed`.
   *
   * This is the half of a merge that is easy to forget and expensive to get wrong: a node
   * left holding a deleted pool id has no usable pool, and resolution then falls through
   * to a DIRECT request — the exact outcome a proxy binding exists to prevent.
   */
  function rebindPools(targetId, absorbed) {
    const dead = new Set(absorbed);
    for (const node of nodes.list()) {
      const ids = node.data?.proxy?.poolIds;
      if (!Array.isArray(ids) || !ids.some((id) => dead.has(id))) continue;
      // De-duplicate: a node bound to two pools that are now one would otherwise carry
      // the target twice, which reads as "rotate between them" over a single fleet.
      const next = [...new Set(ids.map((id) => (dead.has(id) ? targetId : id)))];
      nodes.update(node.id, { data: { proxy: { ...node.data.proxy, poolIds: next } } });
    }
    for (const node of nodes.list()) {
      for (const conn of connections.list(node.id)) {
        if (dead.has(conn.credentials?.proxyPoolId)) {
          connections.update(conn.id, { credentials: { ...conn.credentials, proxyPoolId: targetId } });
        }
      }
    }
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
    /**
     * Drop a breaker outright, RAM and row. `record` cannot express this: it upserts, so a
     * scope whose subject no longer exists would be written back on the next flush. Only for
     * scopes that describe something deleted — a proxy exit, which lives in its own table.
     */
    drop(scope) {
      const had = breakerRam.delete(scope);
      db.prepare(`DELETE FROM breakers WHERE scope = ?`).run(scope);
      return had;
    },
    /**
     * Upsert a breaker. Fields left undefined keep their current value;
     * `failures` sets an absolute count, `failureDelta` adjusts relatively.
     */
    record(scope, { state, openUntil, failureDelta = 0, failures, lastError, ...extra } = {}) {
      const cur = breakerRam.get(scope) || { scope, state: "closed", openUntil: null, failures: 0, lastError: null, updatedAt: "" };
      const next = {
        ...cur,
        ...extra,
        state: state ?? cur.state,
        openUntil: openUntil === undefined ? cur.openUntil : openUntil,
        failures: failures === undefined ? Math.max(0, cur.failures + failureDelta) : Math.max(0, failures),
        lastError: lastError === undefined ? cur.lastError : lastError,
        updatedAt: new Date().toISOString(),
      };
      breakerRam.set(scope, next);
      breakerDirty = true;
      return next;
    },
  };

  // ── usage (synchronous single-row insert; see R3-5 notes) ─────────────────

  const usage = {
    // Synchronous single-row insert returning the event id (R3-5: details need to
    // reference it immediately). One insert per completed request is cheap on WAL;
    // the old write-behind queue existed to batch N-per-request writes.
    record(ev) {
      const info = db.prepare(`INSERT INTO usage_events (ts, node_id, connection_id, api_key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, cost_usd, ttft_ms, duration_ms, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ev.ts ?? Date.now(), ev.nodeId ?? null, ev.connectionId ?? null, ev.apiKeyId ?? null,
        ev.model ?? null, ev.status ?? null,
        ev.promptTokens ?? null, ev.completionTokens ?? null, ev.cachedTokens ?? null,
        ev.costUsd ?? null, ev.ttftMs ?? null, ev.durationMs ?? null, ev.errorCode ?? null,
      );
      return { id: Number(info.lastInsertRowid) };
    },
    flush: () => 0,
    pending: () => 0,
    /**
     * Retention: drop events older than maxAgeDays, then trim to the newest
     * maxRows. Returns deleted counts so the caller can log real work only.
     */
    purge({ maxAgeDays = 90, maxRows = 500000 } = {}) {
      const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
      const aged = db.prepare(`DELETE FROM usage_events WHERE ts < ?`).run(cutoff).changes;
      const capped = db.prepare(`DELETE FROM usage_events WHERE id NOT IN (SELECT id FROM usage_events ORDER BY id DESC LIMIT ?)`).run(maxRows).changes;
      return { aged, capped };
    },
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

  // ── aggregate stats (metrics endpoint; SQL stays in the db layer) ─────────
  const stats = {
    /** `since` is an epoch-ms lower bound; omit for all retained history. */
    requestsByStatus: ({ since = 0 } = {}) =>
      db.prepare(`SELECT COALESCE(status, 'unknown') AS status, COUNT(*) AS n FROM usage_events ${since ? "WHERE ts >= ?" : ""} GROUP BY status`).all(...(since ? [since] : [])),
    requestsByNode: ({ since = 0 } = {}) =>
      db.prepare(`SELECT COALESCE(n.prefix, 'unknown') AS node, COALESCE(u.status, 'unknown') AS status, COUNT(*) AS n
                  FROM usage_events u LEFT JOIN provider_nodes n ON n.id = u.node_id ${since ? "WHERE u.ts >= ?" : ""}
                  GROUP BY n.prefix, u.status`).all(...(since ? [since] : [])),
    totals: ({ since = 0 } = {}) =>
      db.prepare(`SELECT COALESCE(SUM(prompt_tokens), 0) AS promptTokens, COALESCE(SUM(completion_tokens), 0) AS completionTokens,
                         COALESCE(SUM(cost_usd), 0) AS costUsd
                  FROM usage_events ${since ? "WHERE ts >= ?" : ""}`).get(...(since ? [since] : [])),
    ttftByNode: ({ since = 0 } = {}) =>
      db.prepare(`SELECT u.node_id AS nodeId, COALESCE(n.prefix, 'unknown') AS node, COUNT(*) AS n, SUM(u.ttft_ms) AS sum, MIN(u.ttft_ms) AS min, MAX(u.ttft_ms) AS max
                  FROM usage_events u LEFT JOIN provider_nodes n ON n.id = u.node_id
                  WHERE u.ttft_ms IS NOT NULL ${since ? "AND u.ts >= ?" : ""}
                  GROUP BY n.prefix`).all(...(since ? [since] : [])),
    /** Metered spend since a timestamp (unmetered requests store NULL cost). */
    spendSince: (ts) =>
      db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS costUsd, COUNT(*) AS n FROM usage_events WHERE ts >= ? AND cost_usd IS NOT NULL`).get(ts),
  };

  return {
    settings, nodes, connections, apiKeys, combos, aliases, proxyPools, proxyPoolEntries, breakers, usage, requestDetails, nodeModels, stats,
    close() {
      persistBreakers();
    },
  };
}

function safeJson(text) {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Split into fixed-size groups — SQLite has a bound-parameter ceiling. */
function chunksOf(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
