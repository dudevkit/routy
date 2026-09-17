// RE-E gateway core — bootstrap.
// Phase 1.1 skeleton: boots, serves /v1 + /api shells, zero runtime dependencies.
// DB layer, executors, translation: subsequent tasks (roadmap P1.2+).
import http from "node:http";
import { resolveConfig } from "./lib/config.mjs";
import { log, setLogLevel } from "./lib/log.mjs";
import { createRouter, json } from "./lib/router.mjs";
import { createBootstrapToken } from "./lib/auth.mjs";

const cfg = resolveConfig();
setLogLevel(cfg.logLevel);

const VERSION = "0.1.0";
let bootstrapToken = null; // created lazily in dev; printed once
let startedAt = Date.now();

const routes = [
  // ── proxy surface (/v1) — auth enforced per-route as handlers land ──
  {
    method: "GET", pattern: /^\/v1\/models$/,
    handler: async (req, res) => {
      json(res, 200, { object: "list", data: [] }); // populated from db in P1.2
    },
  },
  {
    method: "POST", pattern: /^\/v1\/chat\/completions$/,
    handler: async (req, res) => {
      json(res, 501, { error: { message: "not_implemented", detail: "proxy pipeline lands in P1.4-P1.5" } });
    },
  },
  {
    method: "POST", pattern: /^\/v1\/messages$/,
    handler: async (req, res) => {
      json(res, 501, { error: { message: "not_implemented", detail: "proxy pipeline lands in P1.4-P1.5" } });
    },
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
    bootstrapToken, // management auth until P2 session store; printed once
  });
});

// Graceful shutdown: stop accepting, destroy idle, exit — in-flight streams drain naturally.
function shutdown(signal) {
  log.info("SHUTDOWN", `received ${signal}, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
