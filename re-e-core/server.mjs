// RE-E gateway core — bootstrap.
// P1 complete (proxy pipeline). P2: management API + /ui/* static + loopback guard.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "./lib/config.mjs";
import { log, setLogLevel } from "./lib/log.mjs";
import { createRouter, json } from "./lib/router.mjs";
import { createBootstrapToken } from "./lib/auth.mjs";
import { serveStatic } from "./lib/static.mjs";
import { openDatabase } from "./db/driver.mjs";
import { createRepos } from "./db/repos.mjs";
import { listModels } from "./core/routing.mjs";
import { createChatHandler } from "./core/handlers/chat.mjs";
import { closePools } from "./core/executors/pool.mjs";
import { seedBudget } from "./core/budget.mjs";
import { seedTtft } from "./core/latency.mjs";
import { PROBE_VERSION } from "./core/probe.mjs";
import { buildApiRoutes, mgmtAuthorized } from "./http/api.mjs";
import { createMetricsRoute } from "./http/metrics.mjs";

const cfg = resolveConfig();
setLogLevel(cfg.logLevel);

const VERSION = "0.1.0";
let bootstrapToken = null; // printed once at boot; required for /api from non-loopback peers
globalThis.__bootedAt = Date.now();

// ── single-gateway lock (R3-6): one re-e.db implies one gateway ─────────────
fs.mkdirSync(cfg.home, { recursive: true }); // fresh RE_E_HOME must not crash boot
const lockPath = path.join(cfg.home, "gateway.lock");
if (fs.existsSync(lockPath)) {
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { /* stale */ }
  let alive = false;
  if (holder?.pid) {
    try { process.kill(holder.pid, 0); alive = true; } catch { /* dead holder */ }
  }
  if (alive && holder.pid !== process.pid) {
    console.error(`re-e: another gateway (pid ${holder.pid}, started ${holder.startedAt}) already holds ${cfg.dataDir}. One re-e.db implies one gateway.`);
    process.exit(1);
  }
  fs.rmSync(lockPath); // stale lock from a dead process — take over
}
fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
const releaseLock = () => { try { fs.rmSync(lockPath); } catch { /* already gone */ } };

const db = openDatabase(cfg.dataDir);
const repos = createRepos(db);

// A log level chosen from the dashboard wins over config/env and survives restarts,
// so "turn on debug, reproduce, read the console" keeps working after a reboot.
const persistedLogLevel = repos.settings.get("logLevel");
if (persistedLogLevel && ["debug", "info", "warn", "error"].includes(persistedLogLevel)) {
  setLogLevel(persistedLogLevel);
}

const chatHandler = createChatHandler(repos, { streamIdleTimeoutMs: cfg.streamIdleTimeoutMs });

// ── invalidate stored probe verdicts when probe semantics changed ───────────
// A result produced by an older probe describes a probe that no longer exists,
// and the UI replays it as if it were current. Clearing beats showing a failure
// the current code can no longer produce.
try {
  const seenVersion = Number(repos.settings.get("probeVersion")) || 0;
  if (seenVersion !== PROBE_VERSION) {
    const models = repos.nodeModels.clearTestResults();
    const keys = repos.connections.clearTestResults();
    repos.settings.update({ probeVersion: PROBE_VERSION });
    if (models + keys > 0) {
      log.info("PROBE", `probe semantics changed (v${seenVersion} → v${PROBE_VERSION}) — cleared ${models} model and ${keys} key result(s)`);
    }
  }
} catch (err) {
  log.warn("PROBE", "probe-version check failed", { error: err.message });
}

// ── one-time lift of legacy node.data.models into node_models rows (P6) ─────
try {
  let lifted = 0;
  for (const node of repos.nodes.list()) {
    const legacy = node.data?.models;
    if (Array.isArray(legacy) && legacy.length > 0) lifted += repos.nodeModels.backfill(node.id, legacy);
  }
  if (lifted > 0) log.info("DB", `lifted ${lifted} legacy model(s) into node_models`);
} catch (err) {
  log.warn("DB", "model backfill failed", { error: err.message });
}

// ── P4 routing state: seed the daily budget counter and the latency memory ──
const seededSpend = seedBudget(repos);
if (seededSpend > 0) log.info("BUDGET", `today's metered spend seeded: $${seededSpend.toFixed(4)}`);
try {
  const recent = repos.stats.ttftByNode({ since: Date.now() - 3600_000 });
  for (const r of recent) {
    if (r.nodeId && r.n > 0) seedTtft(r.nodeId, r.sum / r.n);
  }
  if (recent.length) log.info("ROUTE", `latency memory seeded for ${recent.length} node(s)`);
} catch (err) {
  log.warn("ROUTE", "latency seed failed", { error: err.message });
}

// ── retention: age + row caps for details and usage, run at boot and hourly ──
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const retention = cfg.retention || {};
function runRetention() {
  try {
    const details = repos.requestDetails.purge({
      maxAgeDays: retention.detailsDays ?? 7,
      maxRows: retention.detailsMaxRows ?? 50000,
    });
    const usage = repos.usage.purge({
      maxAgeDays: retention.usageDays ?? 90,
      maxRows: retention.usageMaxRows ?? 500000,
    });
    if (details.aged + details.capped + usage.aged + usage.capped > 0) {
      log.info("DB", "retention swept", { details, usage });
    }
  } catch (err) {
    log.warn("DB", "retention failed", { error: err.message });
  }
}
runRetention();
const retentionTimer = setInterval(runRetention, RETENTION_INTERVAL_MS);
retentionTimer.unref?.();

const routes = [
  ...buildApiRoutes(repos, cfg, VERSION, { shutdown }),
  createMetricsRoute(repos, VERSION, () => ({ inflight, startedAt: globalThis.__bootedAt })),
  // ── proxy surface (/v1) — source format detected per request (endpoint + body) ──
  {
    method: "GET", pattern: /^\/v1\/models$/,
    handler: async (req, res) => json(res, 200, listModels(repos)),
  },
  {
    method: "POST", pattern: /^\/v1\/chat\/completions$/,
    handler: chatHandler,
  },
  {
    method: "POST", pattern: /^\/v1\/messages$/,
    handler: chatHandler,
  },
];

const dispatch = createRouter(routes);

// In-flight request count drives graceful shutdown: we drain what is already
// running (a streaming response may be mid-flight) and force-close after the
// grace period. Sockets' close events are the only place this can be tracked.
let inflight = 0;
const server = http.createServer((req, res) => {
  inflight++;
  res.on("close", () => { inflight--; });
  const pathname = new URL(req.url, "http://localhost").pathname;

  if ((pathname.startsWith("/api") || pathname === "/metrics") && !mgmtAuthorized(req, cfg)) {
    return json(res, 401, { error: { message: "auth_error", detail: "management token required for non-loopback peers" } });
  }
  // Proxy surface: chat/messages enforce keys in-handler; /v1/models gets the
  // guard here. Loopback (the SPA's own origin) is trusted by design.
  if (pathname.startsWith("/v1") && repos.settings.get("requireApiKey", true) !== false) {
    const addr = req.socket?.remoteAddress || "";
    const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
    if (!loopback) {
      const bearer = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
      if (!bearer || !repos.apiKeys.verify(bearer.trim())) {
        return json(res, 401, { error: { message: "auth_error", detail: "valid API key required" } });
      }
    }
  }

  // /ui/* static SPA (re-e-ui dist) — same origin, so no CORS needed
  if (!pathname.startsWith("/api") && !pathname.startsWith("/v1") && pathname !== "/metrics" && req.method === "GET" && cfg.uiDir) {
    const uiPath = pathname.startsWith("/ui/") ? pathname.slice(3) : pathname === "/ui" ? "/" : pathname;
    if (serveStatic(res, cfg.uiDir, uiPath)) return;
  }

  dispatch(req, res);
});

server.listen(cfg.port, cfg.host, () => {
  bootstrapToken = createBootstrapToken();
  cfg.bootstrapToken = bootstrapToken; // consulted by mgmtAuthorized for non-loopback peers
  log.info("BOOT", `gateway started (v${VERSION})`, { host: cfg.host, port: cfg.port, ui: cfg.uiDir || null }); // ring provenance — token stays out
  log.raw("BOOT", `re-e-core ${VERSION} listening`, {
    host: cfg.host,
    port: cfg.port,
    home: cfg.home,
    bootstrapToken, // intentionally unredacted: printed exactly once at boot
  });
});

// Graceful shutdown: stop accepting, let in-flight streams finish, then force.
// Aborting a socket fires the handler's res 'close' → clientAbort → upstream
// fetch abort, so the force path also stops upstream work (no orphaned streams).
const SHUTDOWN_GRACE_MS = 10_000;
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("SHUTDOWN", `received ${signal}, draining ${inflight} in-flight request(s)`);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      repos.close();
      db.close();
    } catch (err) {
      log.error("SHUTDOWN", "db close failed", { error: err.message });
    }
    releaseLock();
    // Pools close after the drain so in-flight upstream sockets are not cut early.
    closePools().finally(() => process.exit(0));
  };
  // close() fires its callback once every connection has ended
  server.close(finish);
  server.closeIdleConnections?.(); // drop keep-alive sockets so an idle gateway exits at once
  const deadline = setTimeout(() => {
    log.warn("SHUTDOWN", `grace period elapsed with ${inflight} in-flight — forcing close`);
    server.closeAllConnections?.();
    setTimeout(finish, 250).unref?.(); // let the aborts propagate before exiting
  }, SHUTDOWN_GRACE_MS);
  deadline.unref?.();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
