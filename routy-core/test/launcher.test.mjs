// Launcher supervisor tests.
//
// This is the piece that decides whether a user is left running after an update, so
// it is tested by actually spawning it against a real install layout — fake versions
// that exit with the codes the protocol defines. A unit test with a mocked child
// process would not catch a wrong exit code or a revert that never fires.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "launch.mjs");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "routy-launch-"));
  fs.mkdirSync(path.join(dir, "versions"), { recursive: true });
  fs.copyFileSync(LAUNCHER, path.join(dir, "routy.mjs"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Install a fake version whose script body is `code`. */
function install(version, body) {
  const vdir = path.join(dir, "versions", version);
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, "routy.mjs"), `import fs from "node:fs";\nconst HERE = ${JSON.stringify(vdir)};\n${body}\n`);
}
const setCurrent = (v) => fs.writeFileSync(path.join(dir, "current"), `${v}\n`);
const readCurrent = () => fs.readFileSync(path.join(dir, "current"), "utf8").trim();

function runLauncher(args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, "routy.mjs"), ...args], { cwd: dir });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
    setTimeout(() => child.kill(), 25_000);
  });
}

describe("launcher", () => {
  it("starts the version named by 'current' and exits with it", async () => {
    install("0.1.0", `console.log("running 0.1.0"); process.exit(0);`);
    setCurrent("0.1.0");

    const r = await runLauncher();
    expect(r.code).toBe(0);
    expect(r.out).toContain("running 0.1.0");
    expect(r.out).toContain("starting v0.1.0");
  }, 30_000);

  it("restarts into the new version after an exit 75, then reverts it when it dies", async () => {
    // 0.2.0 is the "new release": it installs itself, says restart, and is broken.
    install("0.1.0", `
      const n = fs.existsSync(HERE + "/runs") ? Number(fs.readFileSync(HERE + "/runs", "utf8")) : 0;
      fs.writeFileSync(HERE + "/runs", String(n + 1));
      if (n === 0) { fs.writeFileSync(${JSON.stringify(path.join(dir, "current"))}, "0.2.0\\n"); process.exit(75); }
      console.log("0.1.0 healthy again"); process.exit(0);
    `);
    install("0.2.0", `console.log("0.2.0 booting"); process.exit(1);`);
    setCurrent("0.1.0");

    const r = await runLauncher();

    // It must have tried the new version, given up on it, and come back.
    expect(r.out).toContain("starting v0.2.0 (updated from v0.1.0)");
    expect(r.out).toMatch(/0\.2\.0 exited after \d+ms \(1\) — reverting to v0\.1\.0/);
    expect(r.out).toContain("0.1.0 healthy again");
    expect(r.code).toBe(0);
    expect(readCurrent()).toBe("0.1.0"); // the pointer is left on the working version
  }, 40_000);

  it("restarts after a crash that is not an update, without reverting", async () => {
    install("0.1.0", `
      const n = fs.existsSync(HERE + "/runs") ? Number(fs.readFileSync(HERE + "/runs", "utf8")) : 0;
      fs.writeFileSync(HERE + "/runs", String(n + 1));
      if (n < 2) { console.log("crash " + n); process.exit(3); }
      console.log("up on attempt " + (n + 1)); process.exit(0);
    `);
    setCurrent("0.1.0");

    const r = await runLauncher();
    expect(r.out).toContain("up on attempt 3");
    expect(r.code).toBe(0);
    expect(readCurrent()).toBe("0.1.0"); // no revert: the version never changed
  }, 40_000);

  it("recovers a missing 'current' pointer instead of refusing to start", async () => {
    install("0.1.0", `console.log("recovered"); process.exit(0);`);
    install("0.1.1", `console.log("recovered"); process.exit(0);`);
    // no current file at all

    const r = await runLauncher();
    expect(r.out).toContain("no 'current' pointer");
    expect(r.out).toContain("recovered");
    expect(readCurrent()).toBe("0.1.1"); // the highest installed version
  }, 30_000);

  it("refuses clearly when there is no install layout", async () => {
    fs.rmSync(path.join(dir, "versions"), { recursive: true, force: true });

    const r = await runLauncher();
    expect(r.code).toBe(1);
    expect(r.out).toContain("no versions/ directory");
    expect(r.out).toContain("node routy-core/server.mjs"); // tells a source user what to do
  }, 30_000);

  it("lists installed versions with --versions", async () => {
    install("0.1.0", `process.exit(0);`);
    install("0.2.0", `process.exit(0);`);
    setCurrent("0.1.0");

    const r = await runLauncher(["--versions"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("current: 0.1.0");
    expect(r.out).toContain("0.2.0");
  }, 30_000);
});
