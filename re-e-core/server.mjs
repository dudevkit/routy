// RE-E gateway core — bootstrap.
// P1 complete (proxy pipeline). P2: management API + /ui/* static + loopback guard.
import http from "node:http";
import { resolveConfig } from "./lib/config.mjs";
import { log, setLogLevel } from "./lib/log.mjs";
import { createRouter, json } from "./lib/router.mjs";
import { createBootstrapToken } from "./lib/auth.mjs";
import { serveStatic } from "./lib/static.mjs";
import { openDatabase } from "./db/driver.mjs";
import { createRepos } from "./db/repos.mjs";
import { listModels } from "./core/routing.mjs";
import { createChatHandler } from "./core/handlers/chat.mjs";
import { FORMATS } from "./core/translate/formats.js";
import { buildApiRoutes, mgmtAuthorized } from "./http/api.mjs";

const cfg = resolveConfig();
setLogLevel(cfg.logLevel);

const VERSION = "0.1.0";
let bootstrapToken = null; // printed once at boot; required for /api from non-loopback peers
let startedAt = Date.now();
globalThis.__bootedAt = startedAt;
const db = openDatabase(cfg.dataDir);
const repos = createRepos(db);
const chatHandler = createChatHandler(repos);

try {
  const purged = repos.requestDetails.purge();
  if (purged.aged + purged.capped > 0) log.info("DB", "request_details purged", purged);
} catch (err) {
  log.warn("DB", "purge failed", { error: err.message });
}

const proxyRoutes = [
  {
    method: "POST", pattern: /^\/v1\/chat\/completions$/,
    handler: (req, res) => chatHandler(req, res, FORMATS.OPENAI),
  },
  {
    method: "POST", pattern: /^\/v1\/messages$/,
    handler: (req, res) => chatHandler(req, res, FORMATS.CLAUDE),
  },
];

const routes = [
  ...buildApiRoutes(repos, cfg, VERSION),
  {
    method: "GET", pattern: /^\/v1\/models$/,
    handler: async (req, res) => json(res, 200, listModels(repos)),
  },
  ...proxyRoutes,
];

const dispatch = createRouter(routes);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname.startsWith("/api") && !mgmtAuthorized(req, cfg)) {
    return json(res, 401, { error: { message: "auth_error", detail: "management token required for non-loopback peers" } });
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
  log.raw("BOOT", `re-e-core ${VERSION} listening`, {
    host: cfg.host,
    port: cfg.port,
    home: cfg.home,
    ui: cfg.uiDir || "not built",
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
