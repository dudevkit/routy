// The replacement process for a dashboard-initiated restart.
//
// Nothing supervises a locally started gateway: `process.exit()` on its own would simply leave the
// user with no routy until someone notices. So the restart contract is "spawn the next one first,
// then take the graceful path" — the button cannot lose the gateway, and the replacement waits for
// the port to free itself (see server.mjs) instead of racing the drain.
import { spawn } from "node:child_process";

/**
 * Start a detached copy of this very process (same execPath, argv, env, cwd).
 *
 * @returns {number} the child's pid
 * @throws when the OS refused to start a child — the caller MUST then keep running, because a
 *   restart that cannot replace itself is a shutdown.
 */
export function spawnReplacement() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ROUTY_RESTARTING: "1" },
    cwd: process.cwd(),
  });
  child.unref();
  if (!child.pid) throw new Error("could not start the replacement process");
  return child.pid;
}
