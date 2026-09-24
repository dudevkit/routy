// routy config — defaults < config.json < env. 12-factor: state in $ROUTY_HOME.
//
// This app shipped as "RE-E" before it was renamed to routy. Every ROUTY_* variable
// still answers to its old RE_E_* name, and a pre-rename home directory is adopted
// on first boot, so an existing install keeps working with no environment changes.
// The legacy spellings below are deliberate — do not "tidy" them away.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_HOME_NAME = ".re-e";
const HOME_NAME = ".routy";

const DEFAULTS = Object.freeze({
  port: 8010,
  // Reachable from the network by default, not just loopback. A gateway you have to
  // re-configure before another machine can use it is a gateway nobody uses off the
  // box. This is safe to default because the guards are independent of the bind:
  // non-loopback peers need the bootstrap token for /api, and a valid client key for
  // /v1. Set ROUTY_HOST=127.0.0.1 to go back to loopback-only.
  host: "0.0.0.0",
  logLevel: "info",
  retention: { detailsDays: 7, detailsMaxRows: 50000, usageDays: 90, usageMaxRows: 500000 },
});

/** First variable that is actually set wins; ROUTY_* is canonical, RE_E_* legacy. */
const envAny = (env, ...names) => names.map((n) => env[n]).find((v) => v !== undefined && v !== "");

/**
 * Where this install keeps its state.
 *
 * Adoption rules, in order: an explicit ROUTY_HOME/RE_E_HOME wins; a home that
 * already exists wins; otherwise a pre-rename `~/.re-e` is moved to `~/.routy`
 * and used. If the move fails — on Windows a running gateway holds its own db
 * open, and a directory with open files cannot be renamed — the legacy home is
 * used in place rather than starting empty, which would look like data loss.
 */
export function resolveHome(env = process.env, { homedir = os.homedir() } = {}) {
  const legacyDefault = path.join(homedir, LEGACY_HOME_NAME);
  const defaultHome = path.join(homedir, HOME_NAME);
  const explicit = envAny(env, "ROUTY_HOME", "RE_E_HOME");

  if (explicit) {
    if (fs.existsSync(explicit)) return { home: explicit, migratedFrom: null };
    // A stale env var can outlive the migration that moved its directory.
    const alt = explicit === legacyDefault ? defaultHome : explicit === defaultHome ? legacyDefault : null;
    if (alt && fs.existsSync(alt)) return { home: alt, migratedFrom: null };
    return { home: explicit, migratedFrom: null };
  }

  if (fs.existsSync(defaultHome)) return { home: defaultHome, migratedFrom: null };
  if (fs.existsSync(legacyDefault)) {
    try {
      fs.renameSync(legacyDefault, defaultHome);
      return { home: defaultHome, migratedFrom: legacyDefault };
    } catch {
      return { home: legacyDefault, migratedFrom: null, migrationFailed: true };
    }
  }
  return { home: defaultHome, migratedFrom: null };
}

export function resolveConfig(env = process.env) {
  const { home, migratedFrom, migrationFailed } = resolveHome(env);
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
    migratedFrom,
    migrationFailed: !!migrationFailed,
  };
  // retention is an object — merge per key so a partial override keeps the rest
  cfg.retention = { ...DEFAULTS.retention, ...(fileCfg.retention || {}) };
  // UI dist: explicit env > next to this module (packaged bundle) > repo layout
  // (source checkout) > <home>/ui. import.meta.url points at the bundle when
  // bundled, so <bundleDir>/ui works with no env var.
  cfg.uiDir = envAny(env, "ROUTY_UI_DIR", "RE_E_UI_DIR") || cfg.uiDir || "";
  if (!cfg.uiDir) {
    const moduleUi = fileURLToPath(new URL("./ui", import.meta.url));
    const candidates = [
      moduleUi,
      path.resolve(process.cwd(), "routy-ui", "dist"),
      path.resolve(process.cwd(), "..", "routy-ui", "dist"),
      path.join(home, "ui"),
    ];
    cfg.uiDir = candidates.find((d) => fs.existsSync(path.join(d, "index.html"))) || "";
  }
  const port = envAny(env, "ROUTY_PORT", "RE_E_PORT");
  if (port) cfg.port = parseInt(port, 10) || cfg.port;
  const host = envAny(env, "ROUTY_HOST", "RE_E_HOST");
  if (host) cfg.host = host;
  const logLevel = envAny(env, "ROUTY_LOG_LEVEL", "RE_E_LOG_LEVEL");
  if (logLevel) cfg.logLevel = logLevel;
  // Stall watchdog budget in ms; 0 disables. Undefined → handler default.
  const idle = envAny(env, "ROUTY_STREAM_IDLE_TIMEOUT_MS", "RE_E_STREAM_IDLE_TIMEOUT_MS");
  if (idle) {
    const v = Number(idle);
    if (Number.isFinite(v) && v >= 0) cfg.streamIdleTimeoutMs = v;
  }
  // Dashboard login lives in Settings, not here: it has to be flippable from the
  // dashboard without a restart, and a second source of truth in the environment is
  // how you end up with a toggle that appears to do nothing.
  return cfg;
}
