// RE-E config — defaults < config.json < env. 12-factor: state in $RE_E_HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = Object.freeze({
  port: 8010,
  host: "127.0.0.1",
  logLevel: "info",
  retention: { detailsDays: 7, detailsMaxRows: 50000, usageDays: 90, usageMaxRows: 500000 },
});

export function resolveConfig(env = process.env) {
  const home = env.RE_E_HOME || path.join(os.homedir(), ".re-e");
  const configPath = path.join(home, "config.json");
  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      // malformed config must not brick boot — proceed with defaults + env
      fileCfg = {};
    }
  }
  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    home,
    configPath,
    dataDir: path.join(home, "data"),
  };
  // retention is an object — merge per key so a partial override keeps the rest
  cfg.retention = { ...DEFAULTS.retention, ...(fileCfg.retention || {}) };
  // UI dist: explicit env > next to this module (packaged bundle) > repo layout
  // (source checkout) > <home>/ui. import.meta.url points at the bundle when
  // bundled, so <bundleDir>/ui works with no env var.
  cfg.uiDir = env.RE_E_UI_DIR || cfg.uiDir || "";
  if (!cfg.uiDir) {
    const moduleUi = fileURLToPath(new URL("./ui", import.meta.url));
    const candidates = [
      moduleUi,
      path.resolve(process.cwd(), "re-e-ui", "dist"),
      path.resolve(process.cwd(), "..", "re-e-ui", "dist"),
      path.join(home, "ui"),
    ];
    cfg.uiDir = candidates.find((d) => fs.existsSync(path.join(d, "index.html"))) || "";
  }
  if (env.RE_E_PORT) cfg.port = parseInt(env.RE_E_PORT, 10) || cfg.port;
  if (env.RE_E_HOST) cfg.host = env.RE_E_HOST;
  if (env.RE_E_LOG_LEVEL) cfg.logLevel = env.RE_E_LOG_LEVEL;
  // Stall watchdog budget in ms; 0 disables. Undefined → handler default.
  if (env.RE_E_STREAM_IDLE_TIMEOUT_MS) {
    const v = Number(env.RE_E_STREAM_IDLE_TIMEOUT_MS);
    if (Number.isFinite(v) && v >= 0) cfg.streamIdleTimeoutMs = v;
  }
  return cfg;
}
