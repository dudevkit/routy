// RE-E gateway core — bootstrap.
// DB (P1.2) + routing (P1.3) + pipeline & translation (P1.4-P1.6) wired.
import http from "node:http";
import { resolveConfig } from "./lib/config.mjs";
import { log, setLogLevel } from "./lib/log.mjs";
import { createRouter, json } from "./lib/router.mjs";
import { createBootstrapToken } from "./lib/auth.mjs";
import { openDatabase } from "./db/driver.mjs";
import { createRepos } from "./db/repos.mjs";
import { listModels } from "./core/routing.mjs";
import { createChatHandler } from "./core/handlers/chat.mjs";
import { FORMATS } from "./core/translate/formats.js";

const cfg = resolveConfig();
setLogLevel(cfg.logLevel);

const VERSION = "0.1.0";
let bootstrapToken = null; // printed once at boot (management auth until P2 session store)
let startedAt = Date.now();

const db = openDatabase(cfg.dataDir);
const repos = createRepos(db);
const chatHandler = createChatHandler(repos);

// request-detail retention runs at boot; schedule-friendly purge lands with metrics (P4)
try {
  const purged = repos.requestDetails.purge();
  if (purged.aged + purged.capped > 0) log.info("DB", "request_details purged", purged);
} catch (err) {
  log.warn("DB", "purge failed", { error: err.message });
}

const routes = [
  // ── proxy surface (/v1) ──
  {
    method: "GET", pattern: /^\/v1\/models$/,
    handler: async (req, res) => {
      json(res, 200, listModels(repos)); // aliases + combos + node prefixes
    },
  },
  {
    method: "POST", pattern: /^\/v1\/chat\/completions$/,
    handler: (req, res) => chatHandler(req, res, FORMATS.OPENAI),
  },
  {
    method: "POST", pattern: /^\/v1\/messages$/,
    handler: (req, res) => chatHandler(req, res, FORMATS.CLAUDE),
  },
  // ── management surface (/api) ──
  {
    method: "GET", pattern: /^\/api\/health$/,
    handler: async (req, res) => {
      json(res, 200, { status: "ok", uptimeMs: Date.now() - startedAt });
    },
  },
  {
    method: "GET", pattern: /^\/api\/version$/,
    handler: async (req, res) => {
      json(res, 200, { version: VERSION, name: "re-e-core" });
    },
  },
];

const dispatch = createRouter(routes);

const server = http.createServer((req, res) => {
  dispatch(req, res);
});

server.listen(cfg.port, cfg.host, () => {
  bootstrapToken = createBootstrapToken();
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
