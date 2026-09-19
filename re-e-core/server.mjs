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
import { buildApiRoutes, mgmtAuthorized } from "./http/api.mjs";

const cfg = resolveConfig();
setLogLevel(cfg.logLevel);

const VERSION = "0.1.0";
let bootstrapToken = null; // printed once at boot; required for /api from non-loopback peers
globalThis.__bootedAt = Date.now();

// ── single-gateway lock (R3-6): one re-e.db implies one gateway ─────────────
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
const chatHandler = createChatHandler(repos);

try {
  const purged = repos.requestDetails.purge();
  if (purged.aged + purged.capped > 0) log.info("DB", "request_details purged", purged);
} catch (err) {
  log.warn("DB", "purge failed", { error: err.message });
}

const routes = [
  ...buildApiRoutes(repos, cfg, VERSION),
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

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname.startsWith("/api") && !mgmtAuthorized(req, cfg)) {
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
  if (!pathname.startsWith("/api") && !pathname.startsWith("/v1") && req.method === "GET" && cfg.uiDir) {
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

// Graceful shutdown: flush queued writes, close db, drain connections, exit.
function shutdown(signal) {
  log.info("SHUTDOWN", `received ${signal}, closing`);
  try {
    repos.close();
    db.close();
  } catch (err) {
    log.error("SHUTDOWN", "db close failed", { error: err.message });
  }
  releaseLock();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
