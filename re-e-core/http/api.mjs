// RE-E management API (/api) — P2.2. Shapes mirror re-e-ui/src/api/types.ts
// (the transport contract). Auth: loopback peers pass; non-loopback requires
// the bootstrap token (Bearer) — the SPA is same-origin by design (P2.1).
import { json, readBody } from "../lib/router.mjs";
import { clearLogs, recentLogs, subscribeLog, subscribeLogClear } from "../lib/log.mjs";

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
  return {
    id: node.id,
    name: node.name,
    baseUrl: node.baseUrl,
    prefix: node.prefix,
    status,
    latencyMs: lastOk ? lastOk.ttft_ms : null,
    modelCount: Number(node.data?.modelCount) || 0,
    keyMasked: maskKey(primary?.credentials?.apiKey),
    lastError: breaker?.lastError || undefined,
  };
}

// ── probe (testNode / testConnection) ───────────────────────────────────────
async function probe(baseUrl, apiKey = null, timeoutMs = 5000) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    let modelCount = 0;
    try {
      const body = await res.json();
      modelCount = Array.isArray(body?.data) ? body.data.length : 0;
    } catch { /* non-JSON models endpoint — probe still ok */ }
    return { ok: true, latencyMs, modelCount };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.cause?.message || err?.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

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
    keyMasked: key ? `re_…${key.id.slice(0, 4)}` : "—",
    version,
  };
}

// ── routes ───────────────────────────────────────────────────────────────────
export function buildApiRoutes(repos, cfg, version) {
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
    repos.breakers.record(`node:${node.id}`, { state: "closed", failures: -999, openUntil: null, lastError: null });
    json(res, 200, nodeView(repos, repos.nodes.get(node.id)));
  });
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/test$/, async (req, res, p) => {
    const node = repos.nodes.get(p.id);
    if (!node) return json(res, 404, { error: { message: "not_found" } });
    const conn = repos.connections.list(node.id)[0];
    const result = await probe(node.baseUrl, conn?.credentials?.apiKey || null);
    if (result.ok && result.modelCount) {
      repos.nodes.update(node.id, { data: { ...(node.data || {}), modelCount: result.modelCount } });
    }
    json(res, 200, result);
  });
  // probe an unsaved baseUrl (Add-Upstream modal "Test Connection")
  route("POST", /^\/api\/nodes\/test$/, async (req, res) => {
    const input = await readBody(req).then((b) => JSON.parse(b.toString("utf8")));
    if (!input?.baseUrl) return json(res, 400, { error: { message: "bad_request", detail: "baseUrl required" } });
    json(res, 200, await probe(input.baseUrl, input.apiKey || null));
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
  route("GET", /^\/api\/version$/, (req, res) => json(res, 200, { version, name: "re-e-core" }));
  route("GET", /^\/api\/gateway$/, (req, res) => json(res, 200, gatewayInfo(repos, cfg, version)));

  // settings
  route("GET", /^\/api\/settings$/, (req, res) => json(res, 200, repos.settings.all()));
  route("PUT", /^\/api\/settings$/, async (req, res) => {
    const patch = JSON.parse((await readBody(req)).toString("utf8"));
    repos.settings.update(patch);
    json(res, 200, repos.settings.all());
  });

  // api keys (router client keys)
  route("GET", /^\/api\/keys$/, (req, res) => json(res, 200, repos.apiKeys.list()));
  route("POST", /^\/api\/keys$/, async (req, res) => {
    const input = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const created = repos.apiKeys.create(input?.name || null);
    json(res, 201, { ...created, warning: "plaintext key shown once — store it now" });
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
    json(res, 201, repos.combos.create(input));
  });
  route("PUT", /^\/api\/combos\/(?<id>[^/]+)$/, async (req, res, p) => {
    const patch = JSON.parse((await readBody(req)).toString("utf8"));
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
    const b = repos.breakers.record(decodeURIComponent(p.scope), { state: "closed", failureDelta: -999, openUntil: null, lastError: null });
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
    json(res, 200, repos.connections.list(p.id).map((c) => ({
      id: c.id, name: c.name, status: c.status, priority: c.priority,
      keyMasked: maskKey(c.credentials?.apiKey), lastError: c.lastError,
    })));
  });
  route("POST", /^\/api\/nodes\/(?<id>[^/]+)\/connections$/, async (req, res, p) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const conn = repos.connections.create({ nodeId: p.id, name: input.name || "key", credentials: { apiKey: input.apiKey } });
    json(res, 201, { id: conn.id, name: conn.name, status: conn.status, priority: conn.priority, keyMasked: maskKey(input.apiKey) });
  });
  route("PUT", /^\/api\/connections\/(?<id>[^/]+)$/, async (req, res, p) => {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const patch = {};
    for (const f of ["name", "status", "priority"]) if (input[f] !== undefined) patch[f] = input[f];
    const conn = repos.connections.update(p.id, patch);
    if (!conn) return json(res, 404, { error: { message: "not_found" } });
    json(res, 200, { id: conn.id, name: conn.name, status: conn.status, priority: conn.priority, keyMasked: maskKey(conn.credentials?.apiKey) });
  });
  route("DELETE", /^\/api\/connections\/(?<id>[^/]+)$/, (req, res, p) => noContent(res, repos.connections.delete(p.id)));

  return R;
}
