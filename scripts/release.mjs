// Cut a release: build, stage the install layout, pack, sign.
//
//   node scripts/release.mjs 0.2.0 [--key <path>] [--out <dir>]
//
// Produces, in dist/release/:
//   routy-0.2.0.tar.gz     the install archive users extract
//   SHA256SUMS             its hash
//   SHA256SUMS.sig         Ed25519 signature over SHA256SUMS (base64)
//
// The archive contains the launcher, the `current` pointer, and the version payload:
//
//   routy.mjs              launcher (never updated)
//   current                "0.2.0"
//   versions/0.2.0/routy.mjs
//   versions/0.2.0/ui/
//
// Nothing here is host-specific, and nothing is signed that was not built from the
// working tree as it stands — the version in package.json is what gets staged, so a
// release cannot disagree with the code it contains.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzip, packTar } from "../routy-core/lib/archive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const coreDir = path.join(repo, "routy-core");
const uiDir = path.join(repo, "routy-ui");

const argv = process.argv.slice(2);
const version = argv.find((a) => !a.startsWith("--"));
const keyFlag = argv.indexOf("--key");
const outFlag = argv.indexOf("--out");
const keyPath = keyFlag >= 0 ? path.resolve(argv[keyFlag + 1]) : path.join(os.homedir(), ".routy", "release-signing.key");
const outDir = outFlag >= 0 ? path.resolve(argv[outFlag + 1]) : path.join(repo, "dist", "release");

const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail("usage: node scripts/release.mjs <version>   e.g. 0.2.0");
}

// The staged version must be the one in package.json: the bundle inlines it, so a
// mismatch would ship a release that reports a different version than its tag.
const pkg = JSON.parse(fs.readFileSync(path.join(coreDir, "package.json"), "utf8"));
if (pkg.version !== version) {
  fail(`package.json says ${pkg.version} but you asked for ${version}. Bump it first:\n  npm --prefix routy-core version ${version} --no-git-tag-version`);
}
if (!fs.existsSync(keyPath)) {
  fail(`no signing key at ${keyPath}\n  generate one: node scripts/release-keys.mjs generate`);
}

// Node 20+ refuses to spawn a .cmd without a shell (CVE-2024-27980), and
// `shell: true` concatenates arguments unescaped. Running npm's JS entry through
// node avoids both.
const NPM_CLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const run = (args, cwd) => {
  process.stdout.write(`  npm ${args.join(" ")}\n`);
  if (fs.existsSync(NPM_CLI)) {
    execFileSync(process.execPath, [NPM_CLI, ...args], { cwd, stdio: "inherit" });
  } else {
    execFileSync("npm", args, { cwd, stdio: "inherit", shell: true }); // unusual install layout
  }
};

console.log(`releasing ${version}\n`);

console.log("· building");
run(["run", "build"], uiDir);
run(["run", "build"], coreDir);

// ── stage the install layout ────────────────────────────────────────────────
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "routy-release-"));
const payload = path.join(stage, "versions", version);
fs.mkdirSync(payload, { recursive: true });

const bundle = path.join(coreDir, "dist", "routy.mjs");
if (!fs.existsSync(bundle)) fail("build produced no bundle");
fs.copyFileSync(bundle, path.join(payload, "routy.mjs"));

const uiSrc = path.join(coreDir, "dist", "ui");
if (fs.existsSync(path.join(uiSrc, "index.html"))) {
  fs.cpSync(uiSrc, path.join(payload, "ui"), { recursive: true });
} else {
  fail("build produced no dashboard — run the UI build first");
}

fs.copyFileSync(path.join(coreDir, "bin", "launch.mjs"), path.join(stage, "routy.mjs"));
fs.writeFileSync(path.join(stage, "current"), `${version}\n`);
fs.writeFileSync(
  path.join(stage, "README.txt"),
  [
    `routy ${version}`,
    "",
    "Run the gateway:      node routy.mjs serve",
    "Installed versions:   node routy.mjs --versions",
    "",
    "Updates are applied in-app. They unpack a new versions/<v>/ directory and",
    "rewrite 'current'; this launcher is never replaced, which is what lets the",
    "gateway update itself on Windows (a running .mjs cannot be overwritten).",
    "",
  ].join("\n"),
);

// ── pack ────────────────────────────────────────────────────────────────────
console.log("· packing");
const entries = [];
(function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // no leading slash at the root — an absolute-looking entry is rejected on
    // extraction, and rightly so
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel);
    else entries.push({ path: rel, data: fs.readFileSync(full) });
  }
})(stage, "");
entries.sort((a, b) => (a.path < b.path ? -1 : 1)); // deterministic archive

const tarball = gzip(packTar(entries));
fs.mkdirSync(outDir, { recursive: true });
const tarballName = `routy-${version}.tar.gz`;
const tarballPath = path.join(outDir, tarballName);
fs.writeFileSync(tarballPath, tarball);

// ── checksum + signature ────────────────────────────────────────────────────
const digest = crypto.createHash("sha256").update(tarball).digest("hex");
const sumsPath = path.join(outDir, "SHA256SUMS");
fs.writeFileSync(sumsPath, `${digest}  ${tarballName}\n`);

const privateKey = crypto.createPrivateKey({
  key: Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64"),
  format: "der",
  type: "pkcs8",
});
const signature = crypto.sign(null, fs.readFileSync(sumsPath), privateKey);
fs.writeFileSync(path.join(outDir, "SHA256SUMS.sig"), `${signature.toString("base64")}\n`);

fs.rmSync(stage, { recursive: true, force: true });

console.log(`\n· staged ${entries.length} files`);
console.log(`  ${tarballName}   ${(tarball.length / 1024).toFixed(0)} KB`);
console.log(`  sha256           ${digest}`);
console.log(`  SHA256SUMS.sig   signed`);
console.log(`\nPublish it:\n  gh release create v${version} \\\n    "${tarballPath}" "${sumsPath}" "${path.join(outDir, "SHA256SUMS.sig")}" \\\n    --title "v${version}" --notes-file <notes.md>`);
