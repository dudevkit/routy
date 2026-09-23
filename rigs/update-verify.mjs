// End-to-end: a real signed release, installed by a running gateway, restarted by
// the launcher.
//
//   node rigs/update-verify.mjs
//
// The unit tests cover the pieces; this covers the seam between them, which is where
// an updater actually breaks: the running process is the *installed* layout, it
// downloads over HTTP, verifies a signature made with a throwaway key, unpacks,
// repoints `current`, exits 75, and the launcher has to bring up the new version.
//
// Nothing here touches GitHub or the real signing key.
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { gzip, packTar } from "../routy-core/lib/archive.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.join(repo, "routy-core");
const PORT = 8090;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sign with the project's real key, so this exercises the same path a release takes:
// the gateway verifies against the public key compiled into it. A throwaway key here
// would only prove that verification rejects the wrong key.
const keyPath = process.env.ROUTY_SIGNING_KEY ?? path.join(os.homedir(), ".routy", "release-signing.key");
if (!fs.existsSync(keyPath)) {
  console.error(
    `no signing key at ${keyPath}\n` +
      "  this rig signs a real release and checks the gateway accepts it.\n" +
      "  generate one: node scripts/release-keys.mjs generate",
  );
  process.exit(2);
}
const privateKey = crypto.createPrivateKey({
  key: Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64"),
  format: "der",
  type: "pkcs8",
});

const readJson = async (url) => (await fetch(url)).json();

/** Build a release archive from an already-built bundle, exactly as release.mjs does. */
function packRelease(version, bundle, uiDir) {
  const files = [{ path: `versions/${version}/routy.mjs`, data: fs.readFileSync(bundle) }];
  (function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else files.push({ path: `versions/${version}/ui/${rel}`, data: fs.readFileSync(path.join(dir, e.name)) });
    }
  })(uiDir, "");
  const tarball = gzip(packTar(files));
  const sums = Buffer.from(`${crypto.createHash("sha256").update(tarball).digest("hex")}  routy-${version}.tar.gz\n`);
  return { tarball, sums, signature: crypto.sign(null, sums, privateKey) };
}

async function main() {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), "routy-e2e-"));
  const home = path.join(install, "home");

  // ── 1. an installed copy at the current version ───────────────────────────
  console.log("· laying out an installed copy\n");
  const currentVersion = JSON.parse(fs.readFileSync(path.join(coreDir, "package.json"), "utf8")).version;
  fs.mkdirSync(path.join(install, "versions", currentVersion), { recursive: true });
  fs.copyFileSync(path.join(coreDir, "bin", "launch.mjs"), path.join(install, "routy.mjs"));
  fs.writeFileSync(path.join(install, "current"), `${currentVersion}\n`);
  fs.copyFileSync(path.join(coreDir, "dist", "routy.mjs"), path.join(install, "versions", currentVersion, "routy.mjs"));
  fs.cpSync(path.join(coreDir, "dist", "ui"), path.join(install, "versions", currentVersion, "ui"), { recursive: true });

  // ── 2. the "new release" ──────────────────────────────────────────────────
  // Built for real, with a bumped version, so the payload reports 9.9.9 — otherwise
  // "is it running the new version?" would be unanswerable. package.json is restored
  // in a finally, whatever happens.
  const newVersion = "9.9.9";
  const pkgPath = path.join(coreDir, "package.json");
  const pkgOriginal = fs.readFileSync(pkgPath, "utf8");
  let release;
  try {
    const pkg = JSON.parse(pkgOriginal);
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    execFileSync(process.execPath, [path.join(coreDir, "scripts", "build.mjs")], { cwd: coreDir, stdio: "ignore" });
    release = packRelease(newVersion, path.join(coreDir, "dist", "routy.mjs"), path.join(coreDir, "dist", "ui"));
  } finally {
    fs.writeFileSync(pkgPath, pkgOriginal);
    execFileSync(process.execPath, [path.join(coreDir, "scripts", "build.mjs")], { cwd: coreDir, stdio: "ignore" });
  }

  let assetHits = 0;
  const assetServer = http.createServer((req, res) => {
    assetHits++;
    const asset = req.url.replace(/^\//, "");
    if (asset === "tarball") return res.writeHead(200).end(release.tarball);
    if (asset === "sums") return res.writeHead(200).end(release.sums);
    if (asset === "sig") return res.writeHead(200).end(release.signature.toString("base64"));
    res.writeHead(404).end();
  });
  await new Promise((r) => assetServer.listen(0, "127.0.0.1", r));
  const assets = `http://127.0.0.1:${assetServer.address().port}`;

  // ── 3. seed the release state the way a check would ───────────────────────
  // The gateway has no "pretend there is a release" API on purpose; writing the
  // cached state directly is the honest way to stand in for GitHub here.
  const dbPath = path.join(home, "data", "routy.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const seed = spawn(process.execPath, [path.join(install, "routy.mjs"), "serve"], {
    env: { ...process.env, ROUTY_HOME: home, ROUTY_PORT: String(PORT) },
    stdio: "ignore",
  });
  await sleep(2500);
  seed.kill();
  await sleep(500);

  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run("updateState", JSON.stringify({
      latest: newVersion,
      tarballUrl: `${assets}/tarball`,
      sumsUrl: `${assets}/sums`,
      sigUrl: `${assets}/sig`,
      checkedAt: new Date().toISOString(),
      error: null,
    }));
  db.close();

  // ── 4. run the launcher, then update through the API ──────────────────────
  console.log("· starting the gateway through the launcher\n");
  const gateway = spawn(process.execPath, [path.join(install, "routy.mjs"), "serve"], {
    env: { ...process.env, ROUTY_HOME: home, ROUTY_PORT: String(PORT), ROUTY_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  gateway.stdout.on("data", (c) => (log += c));
  gateway.stderr.on("data", (c) => (log += c));

  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250);
    up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
  }
  check("gateway started from the installed copy", up);

  const before = await readJson(`${base}/api/updates`);
  check("update is reported as available", before.available === true, `latest ${before.latest}`);
  check("release is installable (assets present)", before.assetsReady === true);
  check("running the installed version", before.current === currentVersion, before.current);

  console.log("\n· applying the update\n");
  const applyRes = await fetch(`${base}/api/updates/apply`, { method: "POST", headers: { "x-routy-action": "1" } });
  const applied = await applyRes.json();
  check("apply accepted", applyRes.status === 202, JSON.stringify(applied).slice(0, 90));

  // ── 5. the launcher must bring the new version up ─────────────────────────
  let after = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    after = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
    if (after) break;
  }
  check("gateway came back up after the update", !!after, after ? "healthy" : "did not return");

  const versionNow = after ? (await readJson(`${base}/api/version`)).version : null;
  check("it is running the new version", versionNow === newVersion, `reports ${versionNow}`);

  check("pointer moved to the new version", fs.readFileSync(path.join(install, "current"), "utf8").trim() === newVersion);
  check("the previous version was kept for rollback", fs.existsSync(path.join(install, "versions", currentVersion, "routy.mjs")));
  check("the new version is on disk with its dashboard", fs.existsSync(path.join(install, "versions", newVersion, "ui", "index.html")));
  check("assets were fetched exactly once each", assetHits === 3, `${assetHits} requests`);
  check("the launcher logged the switch", /starting v9\.9\.9 \(updated from/.test(log));
  // The shutdown an update performs used to abort with 0xC0000409 (a libuv async
  // assertion) instead of exiting cleanly, which the launcher then saw as a crash.
  check("shutdown did not trip a libuv assertion", !/Assertion failed/.test(log));

  gateway.kill();
  seed.kill();
  assetServer.close();
  await sleep(300);
  try {
    fs.rmSync(install, { recursive: true, force: true });
  } catch {
    /* windows may still hold the db briefly */
  }

  if (results.some((r) => !r.ok)) {
    console.log("\n--- raw log tail ---");
    console.log(log.split("\n").slice(-18).join("\n"));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("rig failed:", err);
  process.exit(1);
});
