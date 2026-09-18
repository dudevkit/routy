// re-e CLI — `re-e init` (onboarding wizard) + `re-e serve` (gateway).
// Zero-dep: node:readline/promises + node:process. Runs OUTSIDE the server
// process; edits the same SQLite db (WAL = multi-process safe).
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit, env, argv } from "node:process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../lib/config.mjs";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";

const cfg = resolveConfig();
const db = openDatabase(cfg.dataDir);
const repos = createRepos(db);

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, def = "") => {
  const suffix = def ? ` [${def}]` : "";
  const a = (await rl.question(`${q}${suffix}: `)).trim();
  return a || def;
};

function maskKey(k) {
  return typeof k === "string" && k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? "•••" : "—";
}

// ── step 1: upstream ─────────────────────────────────────────────────────────
async function initUpstream() {
  console.log("\n── Connect an upstream (OpenAI-compatible endpoint) ──");
  const name = await ask("Upstream name", "My upstream");
  const baseUrl = await ask("Base URL (e.g. https://api.openai.com/v1)");
  const apiKey = await ask("API key");
  const prefix = await ask("Model prefix (used as <prefix>/<model>)", name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "upstream");
  if (!baseUrl) { console.log("✗ baseUrl required — skipping upstream."); return null; }
  if (!prefix) { console.log("✗ prefix required — skipping upstream."); return null; }

  const node = repos.nodes.create({ name, prefix, apiType: "openai", baseUrl: baseUrl.trim() });
  if (apiKey) {
    repos.connections.create({ nodeId: node.id, name: `${name} key`, credentials: { apiKey: apiKey.trim() } });
  }
  console.log(`✓ node "${name}" created (prefix: ${prefix})`);

  console.log("  testing connection…");
  const t0 = Date.now();
  let ok = false, modelCount = 0;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey.trim()}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    ok = res.ok;
    if (res.ok) {
      const body = await res.json().catch(() => null);
      modelCount = Array.isArray(body?.data) ? body.data.length : 0;
      repos.nodes.update(node.id, { data: { ...(node.data || {}), modelCount } });
    }
  } catch (err) {
    console.log(`  ⚠ probe failed: ${String(err?.message || err).slice(0, 120)} (node saved anyway)`);
  }
  if (ok) console.log(`✓ connection OK — ${modelCount} models, ${Date.now() - t0}ms`);
  return node;
}

// ── step 2: router api key ───────────────────────────────────────────────────
async function ensureApiKey() {
  const existing = repos.apiKeys.list().filter((k) => k.enabled);
  if (existing.length > 0) {
    console.log("\n── Router API key ──");
    console.log(`  an enabled key already exists (${existing[0].id}) — reuse it or create a new one with: re-e key`);
    return null;
  }
  const { key } = repos.apiKeys.create("init");
  console.log("\n── Router API key (shown ONCE) ──");
  console.log(`  ${key}`);
  return key;
}

// ── step 3: write a CLI tool config ─────────────────────────────────────────
function claudeConfigPatch(baseUrl, apiKey, model) {
  return {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: model,
    },
  };
}

function mergeJsonConfig(file, patch) {
  let base = {};
  if (fs.existsSync(file)) {
    try { base = JSON.parse(fs.readFileSync(file, "utf8")); } catch { base = {}; }
  }
  // deep-merge one level per top-level key (env objects merge, arrays replace)
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      base[k] = { ...base[k], ...v };
    } else {
      base[k] = v;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(base, null, 2) + "\n");
  return file;
}

async function writeCliConfig(baseUrl, apiKey, firstModel) {
  console.log("\n── Point a CLI tool at RE-E ──");
  console.log("  1) Claude Code  (~/.claude/settings.json)");
  console.log("  2) skip — print connection details only");
  const choice = await ask("choice", "2");
  if (choice !== "1") return;
  const home = env.USERPROFILE || env.HOME;
  const file = path.join(home, ".claude", "settings.json");
  const patch = claudeConfigPatch(baseUrl, apiKey, firstModel || `${repos.nodes.list()[0]?.prefix || "upstream"}/*`);
  mergeJsonConfig(file, patch);
  console.log(`✓ wrote ${file} (env.ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)`);
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdInit() {
  console.log(`re-e init — gateway at ${cfg.host}:${cfg.port} (db: ${cfg.dataDir})`);
  const node = await initUpstream();
  const key = await ensureApiKey();
  const firstModel = node ? `${node.prefix}/*` : "";
  await writeCliConfig(`http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}/v1`, key || "<reuse existing key>", firstModel);
  console.log("\n✓ done. Start the gateway with: re-e serve");
  rl.close();
  db.close();
}

async function cmdServe() {
  rl.close();
  db.close();
  await import("../server.mjs"); // boots on cfg.port; stays alive
}

function printHelp() {
  console.log(`re-e — RE-E gateway CLI

  re-e init    connect an upstream, issue a key, point a CLI tool at RE-E
  re-e serve   start the gateway (same as: node server.mjs)
  re-e key     issue a new router API key (printed once)`);
}

async function cmdKey() {
  const { key } = repos.apiKeys.create("cli");
  console.log(key);
  rl.close();
  db.close();
}

async function cmdHelp() { printHelp(); }

const cmd = argv[2] || "help";
const runners = { init: cmdInit, serve: cmdServe, key: cmdKey, help: cmdHelp };
(runners[cmd] || cmdHelp)().catch((err) => {
  console.error("re-e:", err?.message || err);
  exit(1);
});
