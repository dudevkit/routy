// The replacement process for a dashboard-initiated restart.
//
// Nothing supervises a locally started gateway: `process.exit()` on its own would simply leave the
// user with no routy until someone notices. So the restart contract is "spawn the next one first,
// then take the graceful path" — the button cannot lose the gateway, and the replacement waits for
// the port to free itself (see server.mjs) instead of racing the drain.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ROUTY_HOME where it is set, else the default home — same rule the gateway itself resolves. */
const homeDir = process.env.ROUTY_HOME || path.join(os.homedir(), ".routy");

/**
 * Start a detached copy of this very process (same execPath, argv, env, cwd).
 *
 * Its stdout/stderr go to `<home>/restart.log` rather than the void: a replacement that dies
 * silently is an outage nobody can explain, and one did happen — the process that took the lock
 * at 08:17 vanished with no log, no crash and no port. The file is append-mode and inherited by
 * the child, so each restart appends.
 *
 * @returns {number} the child's pid
 * @throws when the OS refused to start a child — the caller MUST then keep running, because a
 *   restart that cannot replace itself is a shutdown.
 */
export function spawnReplacement() {
  let out = null;
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    out = fs.openSync(path.join(homeDir, "restart.log"), "a");
  } catch {
    out = null; // no log: still restart, never fail the restart because logging failed
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: out ? ["ignore", out, out] : "ignore",
    windowsHide: true,
    env: { ...process.env, ROUTY_RESTARTING: "1" },
    cwd: process.cwd(),
  });
  child.unref();
  if (!child.pid) {
    if (out !== null) { try { fs.closeSync(out); } catch { /* already closed */ } }
    throw new Error("could not start the replacement process");
  }
  return child.pid;
}
