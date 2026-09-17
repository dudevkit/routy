// RE-E config — defaults < config.json < env. 12-factor: state in $RE_E_HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = Object.freeze({
  port: 8010,
  host: "127.0.0.1",
  logLevel: "info",
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
  if (env.RE_E_PORT) cfg.port = parseInt(env.RE_E_PORT, 10) || cfg.port;
  if (env.RE_E_HOST) cfg.host = env.RE_E_HOST;
  if (env.RE_E_LOG_LEVEL) cfg.logLevel = env.RE_E_LOG_LEVEL;
  return cfg;
}
