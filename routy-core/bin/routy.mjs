// routy CLI — `routy init` (onboarding wizard) + `routy serve` (gateway).
// Zero-dep: node:readline/promises + node:process. Runs OUTSIDE the server
// process; edits the same SQLite db (WAL = multi-process safe).
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
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
    console.log(`  an enabled key already exists (${existing[0].id}) — reuse it or create a new one with: routy key`);
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
  console.log("\n── Point a CLI tool at routy ──");
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
  console.log(`routy init — gateway at ${cfg.host}:${cfg.port} (db: ${cfg.dataDir})`);
  const node = await initUpstream();
  const key = await ensureApiKey();
  const firstModel = node ? `${node.prefix}/*` : "";
  await writeCliConfig(`http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}/v1`, key || "<reuse existing key>", firstModel);
  console.log("\n✓ done. Start the gateway with: routy serve");
  rl.close();
  db.close();
}

async function cmdServe() {
  rl.close();
  db.close();
  await import("../server.mjs"); // boots on cfg.port; stays alive
}

// ── start: run the gateway and stay useful ───────────────────────────────────
// The default command, because `routy` on its own should do the obvious thing:
// start the gateway, say where it is, and offer the things you would otherwise
// have to remember. `routy serve` is the same server without the menu, for
// services and scripts.

const DASHBOARD_OPEN = { win32: ["cmd", ["/c", "start", ""]], darwin: ["open", []], default: ["xdg-open", []] };

function openDashboard(url) {
  // ROUTY_NO_OPEN keeps a headless or scripted run from launching a browser — and
  // makes the menu testable without spamming windows.
  if (env.ROUTY_NO_OPEN === "1") return false;
  const { win32, darwin, default: fallback } = DASHBOARD_OPEN;
  const [cmd, prefix] = process.platform === "win32" ? win32 : process.platform === "darwin" ? darwin : fallback;
  try {
    spawn(cmd, [...prefix, url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Start the gateway as a child so the menu can restart it without re-execing. */
function startGateway() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let output = "";
  let ready = false;
  const onData = (buf) => {
    output += buf;
    if (!ready && output.includes("listening")) ready = true;
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const waitReady = new Promise((resolve) => {
    const tick = setInterval(() => {
      if (ready) {
        clearInterval(tick);
        resolve(true);
      }
    }, 100);
    child.on("exit", () => {
      clearInterval(tick);
      resolve(false);
    });
    setTimeout(() => {
      clearInterval(tick);
      resolve(ready);
    }, 20_000).unref?.();
  });

  return { child, ready: waitReady, log: () => output };
}

const apiBase = () => `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`;

async function apiGet(path) {
  try {
    const res = await fetch(`${apiBase()}${path}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function cmdStart() {
  db.close();

  const gateway = startGateway();
  const up = await gateway.ready;

  if (!up) {
    console.log("routy: the gateway did not start. Its output:\n");
    console.log(gateway.log().trim() || "(no output)");
    process.exit(1);
  }

  // Reuse the interface created at module load. Closing it and opening a second one
  // over the same stdin ends the stream, and every question then throws "readline
  // was closed" — which is what a piped invocation hits immediately.
  //
  // Returns null at end of input (a pipe, a script, a closed terminal) so the menu
  // can stop. Returning the default there would make it spin forever: every question
  // would resolve empty and re-pick option 1.
  let inputEnded = false;
  rl.once("close", () => {
    inputEnded = true;
  });
  const ask2 = async (q, dflt) => {
    if (inputEnded) return null;
    try {
      const answer = (await rl.question(dflt ? `${q} [${dflt}]: ` : `${q}: `)).trim();
      return answer === "" ? (dflt ?? "") : answer;
    } catch {
      return null;
    }
  };

  // The check runs in the background and the menu appears immediately, so a slow
  // or unreachable GitHub never delays the thing the user actually asked for.
  let updates = null;
  const updatesPromise = apiGet("/api/updates").then((u) => {
    updates = u;
    return u;
  });

  const endpoint = `${apiBase()}/v1`;
  const dashboard = apiBase();

  console.log("");
  console.log(`  routy is running`);
  console.log(`    dashboard  ${dashboard}`);
  console.log(`    endpoint   ${endpoint}`);
  console.log(`    state      ${cfg.home}`);
  console.log("");

  for (;;) {
    await updatesPromise;
    const options = [];
    if (updates?.available && updates.assetsReady) {
      options.push({ key: "update", label: `Update to v${updates.latest}  (running v${updates.current})` });
    }
    options.push({ key: "open", label: "Open the dashboard" });
    options.push({ key: "key", label: "Show a client key to paste into a CLI tool" });
    options.push({ key: "restart", label: "Restart the gateway" });
    options.push({ key: "quit", label: "Quit" });

    console.log("  What next?");
    options.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}`));
    const pick = await ask2("  choice", "1");

    // End of input. Without this the loop never stops: every question resolves
    // empty, Number("") - 1 indexes nothing, and the `?? options[0]` fallback picks
    // option 1 — which opens a browser. Piped stdin turned that into a tab flood.
    if (pick === null) {
      gateway.child.kill();
      await new Promise((r) => setTimeout(r, 300));
      console.log("  gateway stopped");
      process.exit(0);
    }

    const chosen = options[Number(pick) - 1] ?? options[0];
    console.log("");

    if (chosen.key === "open") {
      const opened = openDashboard(dashboard);
      console.log(opened ? `  opened ${dashboard} in your browser` : `  open ${dashboard} in your browser`);
      console.log("");
      continue;
    }

    if (chosen.key === "key") {
      const keys = await apiGet("/api/keys");
      const usable = (keys ?? []).filter((k) => k.enabled && k.key);
      if (!usable.length) {
        console.log("  no client keys yet — create one on the Overview page.");
      } else {
        for (const k of usable) console.log(`  ${k.name ?? "(unlabeled)"}:  ${k.key}`);
      }
      console.log("");
      continue;
    }

    if (chosen.key === "restart") {
      gateway.child.kill();
      await new Promise((r) => setTimeout(r, 500));
      const next = startGateway();
      const ok = await next.ready;
      console.log(ok ? "  restarted" : "  failed to restart");
      console.log("");
      continue;
    }

    if (chosen.key === "update") {
      try {
        const res = await fetch(`${apiBase()}/api/updates/apply`, {
          method: "POST",
          headers: { "x-routy-action": "1" },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.log(`  update failed: ${body?.error?.detail ?? res.status}`);
          console.log("");
          continue;
        }
        console.log(`  v${body.version} installed — restarting`);
        // The server drains and exits; this process is not the launcher, so start
        // the new version the same way the launcher would.
        await new Promise((r) => gateway.child.on("exit", r));
        const next = startGateway();
        const ok = await next.ready;
        console.log(ok ? "  running the new version" : "  the new version did not start");
        console.log("");
        continue;
      } catch (err) {
        console.log(`  update failed: ${err.message}`);
        console.log("");
        continue;
      }
    }

    // quit
    gateway.child.kill();
    await new Promise((r) => setTimeout(r, 300));
    rl.close();
    console.log("  gateway stopped");
    process.exit(0);
  }
}

function printHelp() {
  console.log(`routy — routy gateway CLI

  routy         start the gateway and open the menu
  routy serve   start the gateway in the foreground (for services and scripts)
  routy init    connect an upstream, issue a key, point a CLI tool at routy
  routy key     issue a new client API key (sk-…; also copyable from the Overview page)`);
}

async function cmdKey() {
  const { key } = repos.apiKeys.create("cli");
  console.log(key);
  rl.close();
  db.close();
}

async function cmdHelp() { printHelp(); }

const cmd = argv[2] || "start";
const runners = { start: cmdStart, init: cmdInit, serve: cmdServe, key: cmdKey, help: cmdHelp };
(runners[cmd] || cmdHelp)().catch((err) => {
  console.error("routy:", err?.message || err);
  exit(1);
});
