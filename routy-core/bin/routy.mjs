// routy CLI — `routy init` (onboarding wizard) + `routy serve` (gateway).
// Zero-dep: node:readline/promises + node:process. Runs OUTSIDE the server
// process; edits the same SQLite db (WAL = multi-process safe).
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";
import { stdin, stdout, exit, env, argv } from "node:process";
import path from "node:path";
import fs from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../lib/config.mjs";
import { VERSION } from "../lib/version.mjs";
import { installRoot } from "../core/update-apply.mjs";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";

const cfg = resolveConfig();
const db = openDatabase(cfg.dataDir);
const repos = createRepos(db);

// Created on demand, not at module load. The menu reads keys in raw mode, and a
// readline interface already attached to stdin would swallow them (and, on a pipe,
// consume the whole stream before the first prompt).
let rl = null;
const getRl = () => (rl ??= createInterface({ input: stdin, output: stdout }));
const ask = async (q, def = "") => {
  const suffix = def ? ` [${def}]` : "";
  const a = (await getRl().question(`${q}${suffix}: `)).trim();
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
  rl?.close();
  db.close();
}

async function cmdServe() {
  rl?.close();
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
    const child = spawn(cmd, [...prefix, url], { stdio: "ignore", detached: true, windowsHide: true });
    // A headless box has no xdg-open, and spawn reports that as an asynchronous
    // 'error' event. Unhandled, it takes the whole process down — which on a
    // server means the menu dies, leaves its gateway orphaned holding the db lock,
    // and the launcher restarts into "another gateway already holds data".
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The gateway this menu is bound to — either one it started (a child it owns) or one
 * it attached to (a pid it did not). Both are stoppable; only the first has a child.
 */
let gateway = { child: null, pid: null, ready: Promise.resolve(true), log: () => "", exitCode: () => null };

/** Start the gateway as a child so the menu can restart it without re-execing. */
function startGateway() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    // No console window. Without this, spawning a child process on Windows puts a
    // terminal on the desktop for the gateway the menu started — which is what showed
    // up uninvited during testing. stdio is piped, so nothing is lost by hiding it.
    windowsHide: true,
    env: process.env,
  });
  let output = "";
  let ready = false;
  let exitCode = null;
  const onData = (buf) => {
    output += buf;
    if (!ready && output.includes("listening")) ready = true;
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  // Remembered so the caller can pass it on. Flattening every failure to 1 here is how
  // a lock conflict turned back into a crash: the launcher watches THIS process, and
  // "1" means "retry with backoff" to it.
  child.on("exit", (code) => {
    exitCode = code ?? 1;
  });

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

  return { child, ready: waitReady, log: () => output, exitCode: () => exitCode };
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

// ── choosing ─────────────────────────────────────────────────────────────────
const ANSI = { hide: "\x1b[?25l", show: "\x1b[?25h", up: (n) => `\x1b[${n}A`, clearLine: "\x1b[2K" };

/**
 * A buffered line reader for a non-TTY stdin. Readline cannot be used here: it is
 * created at first use for the init wizard, and attaching it to a pipe consumes the
 * whole stream before the first prompt — which is how a piped run ended up answering
 * every question with nothing. Resolves null at end of input.
 */
const pipeLine = (() => {
  let buf = "";
  let ended = false;
  let started = false;
  const waiters = [];
  const flush = () => {
    while (waiters.length) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        waiters.shift()(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      } else if (ended) {
        const rest = buf.trim();
        buf = "";
        waiters.shift()(rest === "" ? null : rest);
      } else break;
    }
  };
  return () => {
    if (!started) {
      started = true;
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => {
        buf += chunk;
        flush();
      });
      stdin.on("end", () => {
        ended = true;
        flush();
      });
    }
    return new Promise((resolve) => {
      waiters.push(resolve);
      flush();
    });
  };
})();

async function chooseNumbered(question, options, defaultIndex) {
  console.log(`  ${question}`);
  options.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}`));
  const line = await pipeLine();
  if (line === null) return null;
  return options[Number(line) - 1] ?? options[defaultIndex];
}

/**
 * Pick from a list with the arrow keys. Falls back to a numbered prompt when stdin
 * is not a terminal — there is no cursor to move there, and a scripted run should
 * still be able to answer.
 *
 * Resolves null at end of input. The caller must treat that as "stop", never as
 * "take the default": on a pipe every prompt resolves empty, and a default that has
 * a side effect would then fire forever.
 */
function choose(question, options, defaultIndex = 0) {
  if (!stdin.isTTY || !stdout.isTTY) return chooseNumbered(question, options, defaultIndex);

  return new Promise((resolve) => {
    let index = defaultIndex;
    let drawn = 0;

    const draw = (first) => {
      if (!first) stdout.write(ANSI.up(drawn));
      for (let i = 0; i < options.length; i++) {
        const pointer = i === index ? "❯" : " ";
        const label = i === index ? `\x1b[1m${options[i].label}\x1b[22m` : options[i].label;
        stdout.write(`${ANSI.clearLine}  ${pointer} ${label}\n`);
      }
      drawn = options.length;
    };

    const done = (value) => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(ANSI.show);
      resolve(value);
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === "c") return done(null);
      if (key.name === "up" || str === "k") index = (index - 1 + options.length) % options.length;
      else if (key.name === "down" || str === "j") index = (index + 1) % options.length;
      else if (key.name === "return" || key.name === "enter") return done(options[index]);
      else if (/^[1-9]$/.test(str) && Number(str) <= options.length) index = Number(str) - 1;
      else return;
      draw(false);
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(ANSI.hide);
    stdout.write(`  ${question}\n`);
    draw(true);
    stdin.on("keypress", onKey);
  });
}

/**
 * The address another machine would use, for showing what this is reachable at.
 *
 * The first non-internal IPv4 is not good enough: a dev machine with VirtualBox,
 * VMware or a VPN has several, and the first is often one of those. Physical-looking
 * interface names win; anything virtual is only used if nothing else exists.
 */
const VIRTUAL_IFACE = /vbox|vmware|virtual|docker|br-|veth|tun|tap|wg|zt|tailscale|loopback|hyper-v|vethernet/i;
function lanAddress() {
  const candidates = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (ni.address.startsWith("169.254.")) continue; // link-local, never routable
      candidates.push({ name, address: ni.address });
    }
  }
  const physical = candidates.find((c) => !VIRTUAL_IFACE.test(c.name));
  return (physical ?? candidates[0])?.address ?? null;
}

/**
 * Start the gateway detached, so it outlives this menu.
 *
 * It spawns the LAUNCHER when there is one, not the gateway. That matters for exactly
 * one reason: an update makes the gateway exit 75 — "I installed a new version,
 * restart me" — and only the launcher listens for it. A detached gateway with no
 * supervisor installs the update, exits, and stays down: clicking Update would take
 * the server offline with no way back except a shell.
 *
 * A source checkout has no launcher, so the app supervises itself, which is the
 * pre-existing behaviour and correct there.
 */
function startDetached() {
  const root = installRoot();
  const launcher = root ? path.join(root, "routy.mjs") : null;
  const entry = launcher && fs.existsSync(launcher) ? launcher : fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, "serve"], {
    stdio: "ignore",
    detached: true,
    // Without this, a detached child on Windows gets its own console window — so
    // "run in the background" pops a terminal up on the user's desktop, which is the
    // exact opposite of what the option says it does.
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  return child;
}

async function waitForGateway(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (await apiGet("/api/health")) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * A gateway already running on this state directory, if there is one.
 *
 * Checked before starting a second one, because "run in the background" and then
 * running `routy` again later is the ordinary way to use this, and it used to end in
 * a lock message every time. The health endpoint is what proves it — the lock file
 * alone only says a pid exists, and a pid can be anything by now.
 */
async function findRunningGateway() {
  const health = await apiGet("/api/health");
  if (!health) return null;
  let pid = null;
  try {
    pid = JSON.parse(fs.readFileSync(path.join(cfg.home, "gateway.lock"), "utf8"))?.pid ?? null;
  } catch {
    /* no lock file, or unreadable — the health check is the answer that matters */
  }
  return { pid, url: apiBase(), uptimeMs: health.uptimeMs ?? null };
}

function stopRunningGateway() {
  if (!gateway.child && !gateway.pid) return;
  if (gateway.child) {
    gateway.child.kill();
  } else if (gateway.pid) {
    try {
      process.kill(gateway.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Waits for the port to stop answering, so a restart does not race the old process. */
async function waitForGatewayDown(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (!(await apiGet("/api/health"))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function cmdStart() {
  db.close();

  // Attach to a gateway that is already running rather than colliding with it. "Run in
  // the background" and then `routy` again later is the ordinary way to use this, and
  // it used to end in a lock message every single time.
  let attached = false;
  const existing = await findRunningGateway();
  if (existing) {
    const choice = await choose(
      `A gateway is already running at ${existing.url}.`,
      [
        { key: "use", label: "Use the running gateway" },
        { key: "replace", label: "Stop it and start a fresh one" },
        { key: "quit", label: "Quit" },
      ],
      0,
    );
    console.log("");
    if (choice === null || choice.key === "quit") process.exit(0);
    if (choice.key === "replace") {
      gateway = { child: null, pid: existing.pid, ready: Promise.resolve(true), log: () => "", exitCode: () => null };
      stopRunningGateway();
      if (!(await waitForGatewayDown())) {
        console.log("  it did not stop. Something else may be supervising it —");
        console.log("  `systemctl stop routy` if it is a service.");
        console.log("");
        process.exit(1);
      }
    } else {
      attached = true;
      // No child to own, but the pid, so the menu can still stop and restart it.
      gateway = { child: null, pid: existing.pid, ready: Promise.resolve(true), log: () => "", exitCode: () => null };
    }
  }

  if (!attached) {
    gateway = startGateway();
    const up = await gateway.ready;

    if (!up) {
      console.log("routy: the gateway did not start. Its output:\n");
      console.log(gateway.log().trim() || "(no output)");
      // Propagate what the gateway actually exited with. This process is the one the
      // launcher watches, so collapsing every failure to 1 here re-labelled a lock
      // conflict as a crash and put the launcher back into its eight-attempt backoff —
      // which is exactly what the distinct exit code was added to prevent.
      process.exit(gateway.exitCode() ?? 1);
    }
  }

  // The check runs in the background and the menu appears immediately, so a slow
  // or unreachable GitHub never delays the thing the user actually asked for.
  let updates = null;
  const updatesPromise = apiGet("/api/updates").then((u) => {
    updates = u;
    return u;
  });

  const endpoint = `${apiBase()}/v1`;
  const dashboard = apiBase();
  const lan = cfg.host === "0.0.0.0" ? lanAddress() : null;

  console.log("");
  console.log("  routy is running");
  if (lan) {
    console.log(`    dashboard  http://${lan}:${cfg.port}`);
    console.log(`    endpoint   http://${lan}:${cfg.port}/v1`);
    console.log(`               also http://127.0.0.1:${cfg.port} on this machine`);
  } else {
    console.log(`    dashboard  ${dashboard}`);
    console.log(`    endpoint   ${endpoint}`);
  }
  console.log(`    state      ${cfg.home}`);
  if (lan) {
    console.log("");
    console.log(`  Listening on ${cfg.host}, so other machines can reach it. /api needs the boot`);
    console.log("  token, /v1 needs a client key. ROUTY_HOST=127.0.0.1 keeps it local.");
  }
  console.log("");

  for (;;) {
    await updatesPromise;
    const options = [
      // First, so it is the default. Starting a gateway and then blocking the
      // terminal is not what anyone wants from a bare `routy`; this hands it to the
      // background and gives the shell straight back.
      attached
        ? { key: "background", label: "Leave it running and exit" }
        : { key: "background", label: "Run in the background and exit" },
    ];
    if (updates?.available && updates.assetsReady) {
      options.push({ key: "update", label: `Update to v${updates.latest}  (running v${updates.current})` });
    }
    options.push({ key: "open", label: "Open the dashboard" });
    options.push({ key: "key", label: "Show a client key to paste into a CLI tool" });
    options.push({ key: "restart", label: "Restart the gateway" });
    options.push({ key: "quit", label: "Stop the gateway and quit" });

    const chosen = await choose("What next?  (↑/↓ then enter)", options, 0);
    console.log("");

    // End of input. Without this the loop never stops: every prompt resolves empty
    // and the default fires again and again.
    if (chosen === null) {
      // Only clean up what we started. An attached gateway was somebody else's
      // process before this menu existed, and Ctrl-D is not a request to kill it.
      if (attached) {
        console.log("  left the gateway running");
        process.exit(0);
      }
      stopRunningGateway();
      await new Promise((r) => setTimeout(r, 300));
      console.log("  gateway stopped");
      process.exit(0);
    }

    if (chosen.key === "background") {
      if (attached) {
        // It is already detached — there is nothing to hand over.
        console.log(`  already running in the background — ${dashboard}`);
        console.log("");
        process.exit(0);
      }
      // The running gateway is a child of this menu, so it would die with it.
      // Restart it detached — and detached through the LAUNCHER, so an update can
      // still find a supervisor to restart it.
      stopRunningGateway();
      await waitForGatewayDown();
      startDetached();
      const alive = await waitForGateway();
      console.log(alive ? `  running in the background — ${dashboard}` : "  failed to start in the background");
      console.log("");
      process.exit(alive ? 0 : 1);
    }

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
      stopRunningGateway();
      await waitForGatewayDown();
      gateway = startGateway();
      const ok = await gateway.ready;
      attached = false; // we own the replacement
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

        if (attached) {
          // Something else started it, so something else restarts it: systemd, or the
          // launcher that `startDetached` now spawns. We only wait and report.
          const back = await waitForGateway(120);
          console.log(back ? "  running the new version" : "  it did not come back — check the service log");
          console.log("");
          continue;
        }

        // We are the supervisor for this one, so start the new version ourselves.
        await new Promise((r) => gateway.child.on("exit", r));
        gateway = startGateway();
        const ok = await gateway.ready;
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
    stopRunningGateway();
    await new Promise((r) => setTimeout(r, 300));
    rl?.close();
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
  rl?.close();
  db.close();
}

async function cmdHelp() { printHelp(); }

const cmd = argv[2] || "start";

// Handled before dispatch. Every unknown flag falls through to the help text, so
// `routy --version` printing six lines of usage was not an answer — and scripts,
// service wrappers and bug reports all want the version on one line and nothing else.
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(VERSION);
  exit(0);
}

const runners = { start: cmdStart, init: cmdInit, serve: cmdServe, key: cmdKey, help: cmdHelp };
(runners[cmd] || cmdHelp)().catch((err) => {
  console.error("routy:", err?.message || err);
  exit(1);
});
