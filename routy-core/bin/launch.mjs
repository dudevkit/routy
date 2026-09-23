#!/usr/bin/env node
// routy launcher — the one file an installed copy runs, and the only file an update
// never touches.
//
// An installed copy looks like this:
//
//   routy/
//     routy.mjs          this launcher
//     current            a text file: "0.1.0"
//     versions/
//       0.1.0/routy.mjs  the app
//       0.1.0/ui/        the dashboard
//
// Why a launcher at all: Windows will not let a running .mjs be overwritten, so an
// update can never replace the file that is executing. Instead it unpacks a NEW
// version directory and rewrites `current`; the launcher is what turns that pointer
// into a running process. That also buys three things a plain process cannot have:
//
//   · self-update      — exit 75 means "I installed a new version, start it"
//   · crash restart    — with backoff, so a crash loop cannot spin the CPU
//   · auto-revert      — a version that dies immediately after being switched to is
//                        rolled back to the previous one, so a bad release leaves
//                        the user running, not broken
//
// Running from a source checkout does not involve this file at all.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Exit code the app uses to say "a new version is on `current`, restart me".
 * Mirrors RESTART_FOR_UPDATE in core/update-apply.mjs — this file is copied into a
 * release root on its own, so it cannot import the app to share the constant.
 */
export const RESTART_FOR_UPDATE = 75;

/** A version that exits within this window of being switched to never came up. */
const CRASH_WINDOW_MS = 15_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const MAX_CONSECUTIVE_CRASHES = 8;

const here = path.dirname(fileURLToPath(import.meta.url));
const versionsDir = path.join(here, "versions");
const currentFile = path.join(here, "current");

const say = (msg) => console.error(`[routy] ${msg}`);
const die = (msg) => {
  say(msg);
  process.exit(1);
};

const readCurrent = () => {
  try {
    const v = fs.readFileSync(currentFile, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
};

const writeCurrent = (version) => {
  // Written to a temp file and renamed: a half-written pointer would make the next
  // boot read a version that does not exist.
  const tmp = `${currentFile}.tmp`;
  fs.writeFileSync(tmp, `${version}\n`);
  fs.renameSync(tmp, currentFile);
};

const entryFor = (version) => path.join(versionsDir, version, "routy.mjs");

const installedVersions = () => {
  try {
    return fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(entryFor(e.name)))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const exitCodeOf = (child) =>
  new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? `signal:${signal}` : code ?? 0));
    child.on("error", (err) => {
      say(`failed to start the gateway: ${err.message}`);
      resolve(1);
    });
  });

function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--versions") {
    const all = installedVersions();
    console.log(`current: ${readCurrent() ?? "(none)"}`);
    console.log(all.length ? all.map((v) => `  ${v}`).join("\n") : "  (no versions installed)");
    return;
  }

  if (!fs.existsSync(versionsDir)) {
    die(
      `no versions/ directory next to ${path.basename(import.meta.url)}.\n` +
        "  This launcher is for an installed copy (the release archive).\n" +
        "  Running from a source checkout? Use: node routy-core/server.mjs",
    );
  }

  let current = readCurrent();
  if (!current) {
    const all = installedVersions();
    if (!all.length) die("no versions installed and no 'current' pointer — the install looks incomplete.");
    // Recover a missing pointer rather than refusing to start.
    current = all.sort().at(-1);
    say(`no 'current' pointer; defaulting to ${current}`);
    writeCurrent(current);
  }
  if (!fs.existsSync(entryFor(current))) {
    die(`'current' points at ${current}, but ${path.relative(here, entryFor(current))} does not exist.`);
  }

  let previous = null; // the version we were on before the last switch
  let crashes = 0;

  const start = (version) => {
    const child = spawn(process.execPath, [entryFor(version), ...args], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    // Ctrl-C reaches the whole console group on Windows, but forwarding costs
    // nothing and makes a POSIX terminal behave the same way.
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      });
    }
    return child;
  };

  void (async () => {
    for (;;) {
      const switched = previous !== null && current !== previous;
      say(`starting v${current}${switched ? ` (updated from v${previous})` : ""}`);
      const startedAt = Date.now();
      const code = await exitCodeOf(start(current));
      const lived = Date.now() - startedAt;

      if (code === 0) return; // clean shutdown

      // `current` is the desired state, so re-read it however the process ended —
      // an update may have repointed it and then died for an unrelated reason (a
      // crash on the way out is still an installed update). Only exit 75 was
      // previously treated as "look at the pointer", which meant a crash during an
      // update silently restarted the version the user had just replaced.
      const pointer = readCurrent();
      if (pointer && pointer !== current) {
        previous = current;
        current = pointer;
        crashes = 0;
        continue;
      }
      if (code === RESTART_FOR_UPDATE) {
        crashes = 0; // asked to restart, same version
        continue;
      }

      // A crash. If it happened immediately after switching versions, the new
      // version is at fault — go back rather than leaving the user in a loop.
      if (switched && lived < CRASH_WINDOW_MS && previous) {
        say(`v${current} exited after ${lived}ms (${code}) — reverting to v${previous}`);
        writeCurrent(previous);
        const bad = current;
        current = previous;
        previous = bad; // so a revert does not immediately "switch" again
        crashes = 0;
        continue;
      }

      crashes++;
      if (crashes >= MAX_CONSECUTIVE_CRASHES) {
        die(`gateway exited ${crashes} times in a row (last code ${code}) — giving up.`);
      }
      const wait = BACKOFF_MS[Math.min(crashes - 1, BACKOFF_MS.length - 1)];
      say(`gateway exited (${code}); restarting in ${wait}ms [${crashes}/${MAX_CONSECUTIVE_CRASHES}]`);
      await new Promise((r) => setTimeout(r, wait));
    }
  })();
}

main();
