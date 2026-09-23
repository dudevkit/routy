// Apply an update: download, verify, install, ask the launcher to restart.
//
// The order below is the whole design. Nothing is written into the install until a
// signature over the checksums has verified AND the archive's own hash matches those
// checksums — so a compromised repository, a tampered download or a truncated file
// all stop before anything lands on disk.
//
// The install is never modified in place: a new versions/<v>/ directory appears and
// `current` is repointed. That is what makes this work on Windows, where a running
// .mjs cannot be overwritten, and it is what makes a bad release reversible.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafePath, gunzip, unpackTar } from "../lib/archive.mjs";
import { fetchWithTimeout } from "../lib/net.mjs";
import { VERSION, isNewer } from "../lib/version.mjs";
import { RELEASE_PUBLIC_KEY } from "../lib/release-pubkey.mjs";
import { updateState } from "./updates.mjs";

/**
 * Exit code that tells the launcher "a new version is on `current`, start it".
 * Mirrored in bin/launch.mjs, which cannot import it: the launcher is copied into a
 * release root on its own and must stay dependency-free.
 */
export const RESTART_FOR_UPDATE = 75;

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * The install root, when this process is running from an installed copy.
 *
 * An installed copy has `current` next to the launcher, two levels above the running
 * app:  <root>/versions/<v>/routy.mjs  →  <root>.
 * A source checkout or a loose bundle returns null, and the caller must say so
 * rather than invent a place to write.
 */
export function installRoot() {
  // In a bundle every module is inlined, so import.meta.url is the running app
  // file itself: <root>/versions/<v>/routy.mjs
  const versionDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(versionDir, "..", "..");
  // The parent of the version directory must literally be "versions"; in a source
  // checkout this is <repo>/routy-core/core, which correctly fails the test.
  if (path.basename(path.dirname(versionDir)) !== "versions") return null;
  if (!fs.existsSync(path.join(root, "current"))) return null;
  return root;
}

const readPointer = (root) => {
  try {
    return fs.readFileSync(path.join(root, "current"), "utf8").trim() || null;
  } catch {
    return null;
  }
};

const writePointer = (root, version) => {
  const file = path.join(root, "current");
  fs.writeFileSync(`${file}.tmp`, `${version}\n`);
  fs.renameSync(`${file}.tmp`, file);
};

async function download(url, fetchImpl) {
  const res = await fetchWithTimeout(url, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    fetchImpl,
    headers: { "user-agent": `routy/${VERSION}`, accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url.split("/").pop()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ARCHIVE_BYTES) throw new Error("release archive is implausibly large; refusing");
  return buf;
}

/**
 * Verify SHA256SUMS.sig over SHA256SUMS with the embedded public key, then the
 * archive against the entry inside SHA256SUMS.
 */
export function verifyRelease({ sums, signature, tarball, publicKeyB64 = RELEASE_PUBLIC_KEY }) {
  if (!publicKeyB64) {
    throw new Error("this build has no release public key — refusing to install an unverified update");
  }
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });

  // The signature covers the checksum file, not the archive: one signature
  // authorises the hash, and the hash pins the bytes.
  if (!crypto.verify(null, sums, publicKey, signature)) {
    throw new Error("signature does not verify — the release was not signed by this project's key");
  }

  const expected = sums
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name && name.endsWith(".tar.gz"));
  if (!expected) throw new Error("SHA256SUMS does not list an archive");

  const actual = crypto.createHash("sha256").update(tarball).digest("hex");
  if (actual !== expected[0]) {
    throw new Error(`archive hash mismatch (expected ${expected[0].slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
  return { digest: actual, asset: expected[1] };
}

/**
 * Download and install the release GitHub last reported. Returns a result object;
 * on success the caller is expected to drain and exit with the restart code.
 */
export async function applyUpdate(repos, { fetchImpl = fetch, log = null, root = installRoot(), publicKeyB64 } = {}) {
  if (!root) {
    return {
      ok: false,
      status: 409,
      error: "not_installed",
      detail:
        "this copy is not an installed release (no 'current' pointer), so it cannot update itself. " +
        "Update the way you installed it.",
    };
  }

  const state = updateState(repos);
  const cached = repos.settings.get("updateState") ?? {};
  if (!state.enabled) return { ok: false, status: 409, error: "disabled", detail: "update checks are turned off" };
  if (!state.available) {
    return { ok: false, status: 409, error: "not_newer", detail: `v${state.latest ?? "?"} is not newer than v${VERSION}` };
  }
  if (!state.assetsReady) {
    return { ok: false, status: 409, error: "assets_missing", detail: "the release has no signed archive attached" };
  }
  if (!isNewer(state.latest, VERSION)) {
    return { ok: false, status: 409, error: "not_newer", detail: "already up to date" };
  }

  const target = state.latest;
  const dest = path.join(root, "versions", target);
  if (fs.existsSync(dest)) {
    // Someone already installed it; just point at it.
    writePointer(root, target);
    return { ok: true, version: target, restart: true, note: "already installed; restarting into it" };
  }

  log?.info?.("UPDATE", `downloading v${target}`, { from: VERSION });
  const [tarball, sums, sig] = await Promise.all([
    download(cached.tarballUrl, fetchImpl),
    download(cached.sumsUrl, fetchImpl),
    download(cached.sigUrl, fetchImpl),
  ]);

  const { digest } = verifyRelease({
    sums,
    signature: Buffer.from(sig.toString("utf8").trim(), "base64"),
    tarball,
    publicKeyB64,
  });
  log?.info?.("UPDATE", `signature and hash verified for v${target}`, { sha256: digest.slice(0, 16) });

  const entries = unpackTar(gunzip(tarball));
  // The archive is laid out as a whole install; we only want this version's payload.
  const prefix = `versions/${target}/`;
  const payload = entries.filter((e) => e.path.startsWith(prefix));
  if (!payload.length) throw new Error(`archive contains no ${prefix} entries`);
  if (!payload.some((e) => e.path === `${prefix}routy.mjs`)) {
    throw new Error(`archive is missing ${prefix}routy.mjs`);
  }

  // Extract beside the final location, then rename into place: a half-extracted
  // version directory must never look installable.
  const staging = `${dest}.incoming`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const entry of payload) {
      assertSafePath(entry.path);
      const rel = entry.path.slice(prefix.length);
      if (!rel) continue;
      const file = path.join(staging, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.data);
    }
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  const previous = readPointer(root);
  writePointer(root, target);
  log?.info?.("UPDATE", `installed v${target} (was v${previous ?? "unknown"}) — restarting`);

  return { ok: true, version: target, previous, restart: true, digest };
}
