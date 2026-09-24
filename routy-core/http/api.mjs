// routy management API (/api) — P2.2. Shapes mirror routy-ui/src/api/types.ts
// (the transport contract). Auth: loopback peers pass; non-loopback requires
// the bootstrap token (Bearer) — the SPA is same-origin by design (P2.1).
import { json, readBody } from "../lib/router.mjs";
import { COMBO_STRATEGIES } from "../core/routing.mjs";
import { budgetSpent } from "../core/budget.mjs";
import { probeNode, probeKey, probeModel, mapLimit } from "../core/probe.mjs";
import { clearLogs, log, recentLogs, setLogLevel, subscribeLog, subscribeLogClear } from "../lib/log.mjs";
import { checkForUpdate, updateState } from "../core/updates.mjs";
import { RESTART_FOR_UPDATE, applyUpdate } from "../core/update-apply.mjs";
import { getDispatcher, undiciFetch } from "../core/executors/pool.mjs";
import { allStatuses, connectTool, disconnectTool, findAdapter, toolStatus } from "../core/cli-tools.mjs";

const uuid = () => crypto.randomUUID();
const maskKey = (k) => (typeof k === "string" && k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? "•••" : "—");

export function isLoopback(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function mgmtAuthorized(req, cfg) {
  if (isLoopback(req)) return true;
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1].trim() === cfg.bootstrapToken;
}

/**
 * Guard for state-changing endpoints a browser could be tricked into calling.
 *
 * /api trusts loopback, which is right for a local dashboard — but it also means any
 * page the user has open can POST to 127.0.0.1:8010 without a preflight. Requiring a
 * custom header forces one (a cross-origin page cannot satisfy it without CORS
 * approval), and rejecting a foreign Origin covers the rest.
 */
function sameOriginAction(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host = null;
    try {
      host = new URL(origin).hostname;
    } catch {
      host = null;
    }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host ?? "")) {
      json(res, 403, { error: { message: "forbidden", detail: "cross-origin request rejected" } });
      return false;
    }
  }
  if (req.headers["x-routy-action"] !== "1") {
    json(res, 400, { error: { message: "bad_request", detail: "x-routy-action: 1 header required" } });
    return false;
  }
  return true;
}

function noContent(res, ok) {
  res.writeHead(ok ? 204 : 404, { "content-type": "application/json" });
  res.end(ok ? undefined : JSON.stringify({ error: { message: "not_found" } }));
}

// ── node view (the UpstreamNode shape) ──────────────────────────────────────
function nodeView(repos, node, now = Date.now()) {
  const conns = repos.connections.list(node.id);
  const primary = conns[0] || null;
  const breaker = repos.breakers.get(`node:${node.id}`);
  let status = "healthy";
  if (!node.enabled) status = "disabled";
  else if (breaker?.state === "open" && breaker.openUntil && Date.parse(breaker.openUntil) > now) status = "down";
  else if ((breaker?.failures || 0) > 0) status = "degraded";
  // latency: most recent ok usage event ttft for this node
  const events = repos.usage.query({ nodeId: node.id, limit: 20 });
  const lastOk = events.find((e) => e.status === "ok" && e.ttft_ms !== null);
  // discovery list: enabled and not stale (routing passes through regardless)
  const models = repos.nodeModels.list(node.id).filter((m) => m.enabled && !m.stale);
  return {
    id: node.id,
    name: node.name,
    baseUrl: node.baseUrl,
    prefix: node.prefix,
    status,
    latencyMs: lastOk ? lastOk.ttft_ms : null,
    modelCount: models.length,
    models: models.map((m) => m.model),
    /** the node's config bag (pricing, pool tuning, retry overrides) */
    data: node.data || {},
    keyMasked: maskKey(primary?.credentials?.apiKey),
    lastError: breaker?.lastError || undefined,
  };
}

// ── connection view (the NodeConnection shape) — keys stay masked ───────────
function connectionView(c) {
  return {
    id: c.id, name: c.name, status: c.status, priority: c.priority,
    keyMasked: maskKey(c.credentials?.apiKey), lastError: c.lastError,
    // per-key probe result (P6) — diagnostics, never derived from traffic
    lastTestAt: c.lastTestAt ?? null,
    lastTestOk: c.lastTestOk ?? null,
    lastTestTtftMs: c.lastTestTtftMs ?? null,
  };
}

// ── probes (diagnostics — see core/probe.mjs; they never touch usage/breakers) ──

// ── usage aggregates ─────────────────────────────────────────────────────────
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function usageStats(repos) {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const today = startOfToday();
  const week = repos.usage.query({ since: weekAgo, limit: 100000 });
  let tokens7d = 0, costUsd7d = 0, errors = 0, ttfts = [];
  let requestsToday = 0;
  for (const e of week) {
    if (e.ts >= today) requestsToday++;
    tokens7d += (e.prompt_tokens || 0) + (e.completion_tokens || 0);
    costUsd7d += e.cost_usd || 0;
    if (e.status !== "ok") errors++;
    if (e.ttft_ms !== null && e.ttft_ms !== undefined) ttfts.push(e.ttft_ms);
  }
  ttfts.sort((a, b) => a - b);
  const ttftP50 = ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : 0;
  return {
    requestsToday,
    tokens7d,
    costUsd7d: Math.round(costUsd7d * 10000) / 10000,
    // Same counter the budget ceiling enforces against, so the UI cannot disagree
    // with routing about how much of today's budget is gone.
    costUsdToday: Math.round(budgetSpent() * 1_000_000) / 1_000_000,
    errorRatePct: week.length ? Math.round((errors / week.length) * 1000) / 10 : 0,
    ttftP50Ms: ttftP50,
  };
}

function failures(repos, limit = 20) {
  const rows = repos.usage.query({ limit: 200 }).filter((e) => e.status !== "ok").slice(0, limit);
  return rows.map((e) => {
    const node = e.node_id ? repos.nodes.get(e.node_id) : null;
    return {
      id: String(e.id),
      at: new Date(e.ts).toISOString(),
      requestId: String(e.id),
      nodeName: node?.name || e.node_id || "—",
      errorCode: e.error_code || (e.status === "aborted" ? "client_aborted" : "upstream_error"),
      message: e.error_code || e.status || "error",
    };
  });
}

function gatewayInfo(repos, cfg, version) {
  const key = repos.apiKeys.list()[0];
  return {
    online: true,
    endpoint: `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}/v1`,
    // Mask the real key. This used to render a hardcoded "re_…" prefix followed by
    // the key's *id*, so it never showed anything about the key itself — and after
    // the rename to sk- keys it advertised a format that no longer exists.
    // A key created before the value was kept has nothing to show, hence "—".
    keyMasked: key?.key ? maskKey(key.key) : "—",
    version,
  };
}

// ── routes ───────────────────────────────────────────────────────────────────
export function buildApiRoutes(repos, cfg, version, hooks = {}) {
  const R = [];
  const route = (method, pattern, handler) => R.push({ method, pattern, handler });

  // nodes
  route("GET", /^\/api\/nodes$/, (req, res) => {
    json(res, 200, repos.nodes.list().map((n) => nodeView(repos, n)));
  });
  route("POST", /^\/api\/nodes$/, async (req, res) => {
    const input = await readBody(req).then((b) => JSON.parse(b.toString("utf8")));
    for (const f of ["name", "baseUrl", "prefix"]) {
      if (!input[f] || typeof input[f] !== "string") return json(res, 400, { error: { message: "bad_request", detail: `missing ${f}` } });
    }
    if (repos.nodes.byPrefix(input.prefix.trim())) {
      return json(res, 409, { error: { message: "conflict", detail: `prefix "${input.prefix.trim()}" is already in use` } });
    }
    const node = repos.nodes.create({
      name: input.name.trim(), prefix: input.prefix.trim(),
      apiType: input.apiType || "openai", baseUrl: input.baseUrl.trim(),
      data: input.data || null,
    });
    if (input.apiKey) {
      repos.connections.create({ nodeId: node.id, name: `${node.name} key`, credentials: { apiKey: input.apiKey } });
    }
    json(res, 201, nodeView(repos, repos.nodes.get(node.id)));
  });
  route("DELETE", /^\/api\/nodes\/(?<id>[^/]+)$/, (req, res, p) => noContent(res, repos.nodes.delete(p.id)));
  route("PUT", /^\/api\/nodes\/(?<id>[^/]+)$/, async (req, res, p) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const patch = {};
    for (const f of ["name", "baseUrl", "prefix", "apiType", "enabled"]) {
      if (input[f] !== undefined) patch[f] = input[f];
    }
    if (input.data !== undefined) patch.data = input.data;
    const node = repos.nodes.update(p.id, patch);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    if (typeof input.apiKey === "string" && input.apiKey.length > 0) {
      const primary = repos.connections.list(node.id)[0];
      if (primary) repos.connections.update(primary.id, { credentials: { ...primary.credentials, apiKey: input.apiKey } });
      else repos.connections.create({ nodeId: node.id, name: `${node.name} key`, credentials: { apiKey: input.apiKey } });
    }
    json(res, 200, nodeView(repos, repos.nodes.get(node.id)));
  });
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/reset$/, (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    repos.breakers.record(`node:${node.id}`, { state: "closed", failures: 0, openUntil: null, lastError: null });
    json(res, 200, nodeView(repos, repos.nodes.get(node.id)));
  });
  // ── models (P6) ───────────────────────────────────────────────────────────
  // The list is discovery-only: it feeds /v1/models and the UI. Routing still
  // passes any <prefix>/<model> through, so nothing here can break a client.
  route("GET", /^\/api\/nodes\/(?<id>[^/]+)\/models$/, (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const models = repos.nodeModels.list(node.id);
    json(res, 200, { node: node.prefix, models, count: models.length });
  });

  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/models$/, async (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const model = typeof input?.model === "string" ? input.model.trim() : "";
    if (!model) return json(res, 400, { error: { message: "bad_request", detail: "model required" } });
    json(res, 201, repos.nodeModels.create({ nodeId: node.id, model, enabled: input.enabled !== false, source: "manual" }));
  });

  route("PUT", /^\/api\/nodes\/(?<id>[^/]+)\/models\/(?<modelId>[^/]+)$/, async (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const row = repos.nodeModels.get(p.modelId);
    if (!row || row.nodeId !== node.id) return json(res, 404, { error: { message: "not_found" } });
    const patch = JSON.parse((await readBody(req)).toString("utf8"));
    const next = {};
    if (typeof patch.model === "string" && patch.model.trim()) next.model = patch.model.trim();
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    json(res, 200, repos.nodeModels.update(p.modelId, next));
  });

  route("DELETE", /^\/api\/nodes\/(?<id>[^/]+)\/models\/(?<modelId>[^/]+)$/, (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const row = repos.nodeModels.get(p.modelId);
    if (!row || row.nodeId !== node.id) return json(res, 404, { error: { message: "not_found" } });
    noContent(res, repos.nodeModels.delete(p.modelId));
  });

  // Import the upstream model list — merges; manual rows are never touched and
  // imported rows that vanished upstream become stale rather than disappearing.
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/models\/import$/, async (req, res, p, url) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const body = await readBody(req).catch(() => Buffer.from("{}"));
    const input = JSON.parse(body.toString("utf8") || "{}");
    const conns = repos.connections.list(node.id);
    const conn = (input.connectionId && conns.find((c) => c.id === input.connectionId)) || conns[0] || null;
    if (!conn) return json(res, 400, { error: { message: "no_credentials", detail: "add an API key first" } });

    const result = await probeKey(node, conn, { log });
    if (!result.ok) return json(res, 502, { error: { message: "upstream_error", detail: result.error, latencyMs: result.latencyMs } });
    repos.connections.recordTest(conn.id, { ok: true, latencyMs: result.latencyMs });
    const summary = repos.nodeModels.import(node.id, result.models || []);
    json(res, 200, { ...summary, latencyMs: result.latencyMs, listed: (result.models || []).length, models: repos.nodeModels.list(node.id) });
  });

  // Bulk actions over a selection of models — one round trip, and the test action
  // runs with bounded concurrency so 60 probes don't open 60 sockets.
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/models\/bulk$/, async (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const action = input?.action;
    const ids = Array.isArray(input?.ids) ? input.ids.filter((i) => typeof i === "string" && i) : [];
    if (!["hide", "show", "delete", "test"].includes(action)) {
      return json(res, 400, { error: { message: "bad_request", detail: "action must be hide | show | delete | test" } });
    }
    if (ids.length === 0) return json(res, 400, { error: { message: "bad_request", detail: "ids array required" } });

    // Scope every id to this node — an id from another provider is ignored, not acted on.
    const rows = ids.map((id) => repos.nodeModels.get(id)).filter((r) => r && r.nodeId === node.id);
    if (rows.length === 0) return json(res, 404, { error: { message: "not_found", detail: "no models matched" } });

    if (action === "hide" || action === "show") {
      const changed = repos.nodeModels.setEnabledMany(node.id, rows.map((r) => r.id), action === "show");
      return json(res, 200, { action, changed, models: repos.nodeModels.list(node.id) });
    }
    if (action === "delete") {
      const changed = repos.nodeModels.deleteMany(node.id, rows.map((r) => r.id));
      return json(res, 200, { action, changed, models: repos.nodeModels.list(node.id) });
    }

    // action === "test"
    const conns = repos.connections.list(node.id);
    const conn = conns[0] || null;
    if (!conn) return json(res, 400, { error: { message: "no_credentials", detail: "add an API key first" } });
    const results = await mapLimit(rows, 4, async (row) => {
      const r = await probeModel(node, row.model, conn, { log });
      repos.nodeModels.recordTest(row.id, r);
      return { modelId: row.id, model: row.model, ok: r.ok, ttftMs: r.ttftMs, error: r.error };
    });
    json(res, 200, {
      action, tested: results.length, ok: results.filter((r) => r.ok).length,
      results, models: repos.nodeModels.list(node.id),
    });
  });

  // Prove one model id actually serves — a real (tiny) stream, recorded on the row.
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/models\/(?<modelId>[^/]+)\/test$/, async (req, res, p, url) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const row = repos.nodeModels.get(p.modelId);
    if (!row || row.nodeId !== node.id) return json(res, 404, { error: { message: "not_found" } });
    const conns = repos.connections.list(node.id);
    const conn = (url.searchParams.get("connectionId") && conns.find((c) => c.id === url.searchParams.get("connectionId"))) || conns[0] || null;
    if (!conn) return json(res, 400, { error: { message: "no_credentials", detail: "add an API key first" } });

    const result = await probeModel(node, row.model, conn, { log });
    json(res, 200, { ...repos.nodeModels.recordTest(row.id, result), result });
  });

  // ── API keys (P6) ─────────────────────────────────────────────────────────
  // Probe ONE key: proves that key is valid without touching node health or the
  // other keys, and without spending the budget (no usage event is written).
  route("POST", /^\/api\/connections\/(?<id>[^/]+)\/test$/, async (req, res, p) => {
    const conn = repos.connections.get(p.id);
    if (!conn) return json(res, 404, { error: { message: "not_found" } });
    const node = repos.nodes.get(conn.nodeId);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const result = await probeKey(node, conn, { log });
    repos.connections.recordTest(conn.id, { ok: result.ok, latencyMs: result.latencyMs, error: result.ok ? null : result.error });
    json(res, 200, { connectionId: conn.id, ok: result.ok, latencyMs: result.latencyMs, modelCount: result.modelCount ?? 0, error: result.error ?? null });
  });

  // Probe every active key of a node with bounded concurrency (one round trip).
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/keys\/test$/, async (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const active = repos.connections.list(node.id).filter((c) => c.status === "active");
    const results = await mapLimit(active, 4, async (conn) => {
      const r = await probeKey(node, conn, { log });
      repos.connections.recordTest(conn.id, { ok: r.ok, latencyMs: r.latencyMs, error: r.ok ? null : r.error });
      return { connectionId: conn.id, name: conn.name, ok: r.ok, latencyMs: r.latencyMs, modelCount: r.modelCount ?? 0, error: r.error ?? null };
    });
    json(res, 200, { node: node.prefix, tested: results.length, ok: results.filter((r) => r.ok).length, results });
  });

  // probe an unsaved baseUrl (Add-Provider modal "Test Connection")
  route("POST", /^\/api\/nodes\/test$/, async (req, res) => {
    const input = await readBody(req).then((b) => JSON.parse(b.toString("utf8")));
    if (!input?.baseUrl) return json(res, 400, { error: { message: "bad_request", detail: "baseUrl required" } });
    json(res, 200, await probeNode(input.baseUrl, input.apiKey || null));
  });

  // usage
  route("GET", /^\/api\/usage\/details$/, (req, res, p, url) => {
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const usageEventId = url.searchParams.get("usageEventId");
    json(res, 200, repos.requestDetails.list({ limit, usageEventId: usageEventId ? Number(usageEventId) : undefined }));
  });

  // usage
  route("GET", /^\/api\/usage\/stats$/, (req, res) => json(res, 200, usageStats(repos)));
  route("GET", /^\/api\/usage\/failures$/, (req, res, p, url) => {
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    json(res, 200, failures(repos, limit));
  });
  route("GET", /^\/api\/usage\/history$/, (req, res, p, url) => {
    const since = url.searchParams.get("since") ? parseInt(url.searchParams.get("since"), 10) : undefined;
    const limit = parseInt(url.searchParams.get("limit") || "200", 10);
    json(res, 200, repos.usage.query({ since, limit }).map((e) => ({ ...e, at: new Date(e.ts).toISOString() })));
  });
  route("GET", /^\/api\/usage\/details$/, (req, res, p, url) => {
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    json(res, 200, repos.requestDetails.list({ limit }));
  });

  // gateway info + health/version
  route("GET", /^\/api\/health$/, (req, res) => json(res, 200, { status: "ok", uptimeMs: Date.now() - (globalThis.__bootedAt || Date.now()) }));
  route("GET", /^\/api\/version$/, (req, res) => json(res, 200, { version, name: "routy" }));
  route("GET", /^\/api\/gateway$/, (req, res) => json(res, 200, gatewayInfo(repos, cfg, version)));
  // Graceful stop for scripts and service managers (Windows has no SIGTERM).
  // Answer first so the caller sees a clean 202, then drain and exit.
  route("POST", /^\/api\/gateway\/shutdown$/, (req, res) => {
    if (!hooks.shutdown) return json(res, 501, { error: { message: "not_supported" } });
    json(res, 202, { status: "shutting_down" });
    setImmediate(() => hooks.shutdown("api"));
  });

  // settings
  route("GET", /^\/api\/settings$/, (req, res) => json(res, 200, repos.settings.all()));
  route("PUT", /^\/api\/settings$/, async (req, res) => {
    const patch = JSON.parse((await readBody(req)).toString("utf8"));
    if (patch.logLevel !== undefined && !["debug", "info", "warn", "error"].includes(patch.logLevel)) {
      return json(res, 400, { error: { message: "bad_request", detail: "logLevel must be debug | info | warn | error" } });
    }
    repos.settings.update(patch);
    // log level is live: flipping to debug must not need a restart to trace a request
    if (patch.logLevel !== undefined) {
      setLogLevel(patch.logLevel);
      log.info("LOG", `capture level set to ${patch.logLevel}`);
    }
    json(res, 200, repos.settings.all());
  });

  // ── updates ───────────────────────────────────────────────────────────────
  route("GET", /^\/api\/updates$/, (req, res) => json(res, 200, updateState(repos)));

  route("POST", /^\/api\/updates\/check$/, async (req, res) => {
    if (!sameOriginAction(req, res)) return;
    json(res, 200, await checkForUpdate(repos, { force: true, log }));
  });

  route("POST", /^\/api\/updates\/dismiss$/, async (req, res) => {
    if (!sameOriginAction(req, res)) return;
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    // Dismissal is per version, so silencing 0.2.0 does not also silence 0.3.0.
    repos.settings.update({ updateDismissed: body?.version ?? null });
    json(res, 200, updateState(repos));
  });

  route("POST", /^\/api\/updates\/apply$/, async (req, res) => {
    if (!sameOriginAction(req, res)) return;
    let result;
    try {
      // Download through a pool routy owns rather than built-in fetch. Node's
      // bundled dispatcher keeps its own keep-alive sockets, closePools() cannot
      // reach them, and exiting while they close aborts the process on Windows —
      // which is how an update used to look like a crash to the launcher.
      result = await applyUpdate(repos, {
        log,
        fetchImpl: (url, opts) => undiciFetch(url, { ...opts, dispatcher: getDispatcher({ baseUrl: url }) }),
      });
    } catch (err) {
      log.warn("UPDATE", `update failed: ${err.message}`);
      return json(res, 502, { error: { message: "update_failed", detail: err.message } });
    }
    if (!result.ok) {
      return json(res, result.status ?? 400, { error: { message: result.error, detail: result.detail } });
    }
    // Answer first, then drain: the client must not be left holding a connection
    // that the shutdown is about to cut.
    json(res, 202, { ...result, restarting: true });
    if (result.restart && hooks.shutdown) {
      setImmediate(() => hooks.shutdown("update", RESTART_FOR_UPDATE));
    }
  });

  // ── cli tools ─────────────────────────────────────────────────────────────
  // These edit files the user owns (their Claude/Codex config), so every mutating
  // route carries the same guard as the updater: a hostile page must not be able to
  // rewrite a developer's CLI config by POSTing to loopback.
  route("GET", /^\/api\/cli-tools$/, (req, res) => json(res, 200, { tools: allStatuses(repos) }));

  route("POST", /^\/api\/cli-tools\/(?<id>[^/]+)\/connect$/, async (req, res, p) => {
    if (!sameOriginAction(req, res)) return;
    const input = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    // Default to this gateway's own endpoint, so the common case needs no argument.
    const baseUrl = input.baseUrl || gatewayInfo(repos, cfg, version).endpoint;
    const result = connectTool(repos, p.id, { baseUrl, apiKey: input.apiKey ?? null, model: input.model ?? null });
    if (!result.ok) return json(res, result.error === "unknown_tool" ? 404 : 400, { error: result });
    log.info("CLI", `connected ${p.id} → ${baseUrl}`);
    json(res, 200, { ...result, status: toolStatus(repos, findAdapter(p.id)) });
  });

  route("POST", /^\/api\/cli-tools\/(?<id>[^/]+)\/disconnect$/, async (req, res, p) => {
    if (!sameOriginAction(req, res)) return;
    const result = disconnectTool(repos, p.id);
    if (!result.ok) return json(res, result.error === "unknown_tool" ? 404 : 400, { error: result });
    log.info("CLI", `disconnected ${p.id} (restored ${result.restored?.length ?? 0} key(s))`);
    json(res, 200, { ...result, status: toolStatus(repos, findAdapter(p.id)) });
  });

  // api keys (router client keys)
  route("GET", /^\/api\/keys$/, (req, res) => json(res, 200, repos.apiKeys.list()));
  route("POST", /^\/api\/keys$/, async (req, res) => {
    const input = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const created = repos.apiKeys.create(input?.name || null);
    json(res, 201, created);
  });
  route("PUT", /^\/api\/keys\/(?<id>[^/]+)$/, async (req, res, p) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    if (typeof input.enabled !== "boolean") return json(res, 400, { error: { message: "bad_request", detail: "enabled (boolean) required" } });
    noContent(res, repos.apiKeys.setEnabled(p.id, input.enabled));
  });
  route("DELETE", /^\/api\/keys\/(?<id>[^/]+)$/, (req, res, p) => noContent(res, repos.apiKeys.delete(p.id)));

  // combos
  route("GET", /^\/api\/combos$/, (req, res) => json(res, 200, repos.combos.list()));
  route("POST", /^\/api\/combos$/, async (req, res) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    if (input.strategy !== undefined && !COMBO_STRATEGIES.includes(input.strategy)) {
      return json(res, 400, { error: { message: "bad_request", detail: `strategy must be one of ${COMBO_STRATEGIES.join(", ")}` } });
    }
    json(res, 201, repos.combos.create(input));
  });
  route("PUT", /^\/api\/combos\/(?<id>[^/]+)$/, async (req, res, p) => {
    const patch = JSON.parse((await readBody(req)).toString("utf8"));
    if (patch.strategy !== undefined && !COMBO_STRATEGIES.includes(patch.strategy)) {
      return json(res, 400, { error: { message: "bad_request", detail: `strategy must be one of ${COMBO_STRATEGIES.join(", ")}` } });
    }
    json(res, 200, repos.combos.update(p.id, patch));
  });
  route("DELETE", /^\/api\/combos\/(?<id>[^/]+)$/, (req, res, p) => noContent(res, repos.combos.delete(p.id)));

  // aliases
  route("GET", /^\/api\/aliases$/, (req, res) => json(res, 200, repos.aliases.map()));
  route("PUT", /^\/api\/aliases\/(?<alias>[^/]+)$/, async (req, res, p) => {
    const patch = JSON.parse((await readBody(req)).toString("utf8"));
    repos.aliases.set(p.alias, patch.target);
    json(res, 200, { alias: p.alias, target: patch.target });
  });
  route("DELETE", /^\/api\/aliases\/(?<alias>[^/]+)$/, (req, res, p) => noContent(res, repos.aliases.delete(p.alias)));

  // proxy pools
  route("GET", /^\/api\/proxy-pools$/, (req, res) => json(res, 200, repos.proxyPools.list()));
  route("POST", /^\/api\/proxy-pools$/, async (req, res) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    json(res, 201, repos.proxyPools.create(input));
  });
  route("PUT", /^\/api\/proxy-pools\/(?<id>[^/]+)$/, async (req, res, p) => {
    const patch = JSON.parse((await readBody(req)).toString("utf8"));
    json(res, 200, repos.proxyPools.update(p.id, patch));
  });
  route("DELETE", /^\/api\/proxy-pools\/(?<id>[^/]+)$/, (req, res, p) => noContent(res, repos.proxyPools.delete(p.id)));
  route("POST", /^\/api\/proxy-pools\/(?<id>[^/]+)\/test$/, async (req, res, p) => {
    const pool = repos.proxyPools.get(p.id);
    if (!pool) return json(res, 404, { error: { message: "not_found" } });
    const urls = pool.config?.urls || [];
    const results = [];
    for (const u of urls) {
      const t0 = Date.now();
      const probeUrl = typeof u === "string" ? u : u.url;
      try {
        const r = await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
        results.push({ url: probeUrl, ok: r.ok, latencyMs: Date.now() - t0 });
      } catch (err) {
        results.push({ url: probeUrl, ok: false, error: String(err?.message || err).slice(0, 120) });
      }
    }
    json(res, 200, { ok: results.some((r) => r.ok), results });
  });

  // breakers
  route("POST", /^\/api\/breakers\/(?<scope>[^/]+)\/reset$/, (req, res, p) => {
    const b = repos.breakers.record(decodeURIComponent(p.scope), { state: "closed", failures: 0, openUntil: null, lastError: null });
    json(res, 200, b);
  });

  // live log stream (SSE): init snapshot → live lines. ?level= filters server-side
  // (debug < info < warn < error); POST /api/logs/clear clears the ring + notifies.
  route("GET", /^\/api\/logs\/stream$/, (req, res, p, url) => {
    const levelOrder = { debug: 10, info: 20, warn: 30, error: 40 };
    const minLevel = levelOrder[url.searchParams.get("level") || "debug"] || 10;
    const lineOk = (text) => {
      try { return levelOrder[JSON.parse(text).level] >= minLevel; } catch { return minLevel <= 10; }
    };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event, payload) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    send("init", { lines: recentLogs(200).filter(lineOk) });
    const unsub = subscribeLog((text) => {
      if (res.writableEnded || !lineOk(text)) return;
      try { send("line", { text }); } catch { /* client gone */ }
    });
    const unsubClear = subscribeLogClear(() => {
      if (!res.writableEnded) send("clear", {});
    });
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    ping.unref?.();
    res.on("close", () => { clearInterval(ping); unsub(); unsubClear(); });
  });
  route("POST", /^\/api\/logs\/clear$/, (req, res) => {
    clearLogs();
    json(res, 200, { ok: true });
  });

  // connections (per-node key management; masked)
  route("GET", /^\/api\/nodes\/(?<id>[^/]+)\/connections$/, (req, res, p) => {
    json(res, 200, repos.connections.list(p.id).map(connectionView));
  });
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/connections$/, async (req, res, p) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const conn = repos.connections.create({ nodeId: p.id, name: input.name || "key", credentials: { apiKey: input.apiKey } });
    json(res, 201, connectionView(conn));
  });
  // batch key import — one POST, N connections under the same node.
  // Each entry may carry its own label; without one the key is auto-named.
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/connections\/batch$/, async (req, res, p) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const raw = Array.isArray(input.entries)
      ? input.entries.map((e) => (typeof e === "string" ? { name: "", apiKey: e } : { name: e?.name, apiKey: e?.apiKey }))
      : (Array.isArray(input.keys) ? input.keys.map((k) => ({ name: "", apiKey: k })) : []);
    const entries = raw
      .map((e) => ({ name: typeof e.name === "string" ? e.name.trim() : "", apiKey: typeof e.apiKey === "string" ? e.apiKey.trim() : "" }))
      .filter((e) => e.apiKey.length > 0);
    if (entries.length === 0) return json(res, 400, { error: { message: "bad_request", detail: "entries array required (non-empty keys)" } });
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });

    const created = entries.map((entry, i) => {
      const conn = repos.connections.create({
        nodeId: node.id,
        name: entry.name || (input.name ? `${input.name} ${i + 1}` : `${node.name} key ${i + 1}`),
        credentials: { apiKey: entry.apiKey },
        priority: (input.priority ?? 100) + i,
      });
      return { id: conn.id, name: conn.name, keyMasked: maskKey(entry.apiKey), priority: conn.priority };
    });
    json(res, 201, { created: created.length, connections: created });
  });
  route("PUT", /^\/api\/connections\/(?<id>[^/]+)$/, async (req, res, p) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const patch = {};
    for (const f of ["name", "status", "priority"]) if (input[f] !== undefined) patch[f] = input[f];
    const conn = repos.connections.update(p.id, patch);
    if (!conn) return json(res, 404, { error: { message: "not_found" } });
    json(res, 200, connectionView(conn));
  });
  route("DELETE", /^\/api\/connections\/(?<id>[^/]+)$/, (req, res, p) => noContent(res, repos.connections.delete(p.id)));

  return R;
}
