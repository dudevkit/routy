// Update pipeline tests.
//
// This is the path that downloads code from the internet and runs it, so the tests
// exercise the real thing: a genuinely signed release, served over HTTP, verified,
// unpacked and installed into a real layout on disk. The signature checks are the
// point — a mock would only prove the mock works.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzip, packTar, unpackTar } from "../lib/archive.mjs";
import { compareVersions, isNewer } from "../lib/version.mjs";
import { applyUpdate, installRoot, verifyRelease } from "../core/update-apply.mjs";
import { checkForUpdate, updateState } from "../core/updates.mjs";

let tmp, repos, server, baseUrl;
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** A minimal settings store — the same surface the real repos expose. */
function fakeRepos(initial = {}) {
  const state = { updateCheck: true, ...initial };
  return {
    settings: {
      get: (k, fallback) => (k in state ? state[k] : fallback),
      update: (patch) => Object.assign(state, patch),
      _state: state,
    },
  };
}

/** Build a release exactly as scripts/release.mjs does, including the signature. */
function buildRelease(version, { tamper = false, sign = true, signWith = privateKey } = {}) {
  const files = [
    { path: `versions/${version}/routy.mjs`, data: `console.log("payload ${version}")\n` },
    { path: `versions/${version}/ui/index.html`, data: "<html>ui</html>" },
  ];
  let tarball = gzip(packTar(files));
  const sums = Buffer.from(`${crypto.createHash("sha256").update(tarball).digest("hex")}  routy-${version}.tar.gz\n`);
  const signature = sign ? crypto.sign(null, sums, signWith) : Buffer.alloc(64);
  if (tamper) tarball = Buffer.concat([tarball, Buffer.from("junk")]); // hash no longer matches
  return { tarball, sums, signature };
}

function serveAssets(release) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const asset = req.url.replace(/^\//, "");
      if (asset === "tarball") return res.writeHead(200).end(release.tarball);
      if (asset === "sums") return res.writeHead(200).end(release.sums);
      if (asset === "sig") return res.writeHead(200).end(release.signature.toString("base64"));
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

/** Point the cached release state at the local asset server. */
function pointAtLocalRelease(repos, version, extra = {}) {
  repos.settings.update({
    updateState: {
      latest: version,
      tarballUrl: `${baseUrl}/tarball`,
      sumsUrl: `${baseUrl}/sums`,
      sigUrl: `${baseUrl}/sig`,
      checkedAt: new Date().toISOString(),
      error: null,
      ...extra,
    },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-update-"));
  repos = fakeRepos();
});
afterEach(() => {
  server?.close();
  server = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("version comparison", () => {
  it("orders numerically, not lexically", () => {
    // the trap: "0.10.0" sorts before "0.9.0" as a string
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  it("ranks a pre-release below its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
  });

  it("does not treat the running version as an update", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });
});

describe("signature verification", () => {
  it("accepts a correctly signed release", () => {
    const r = buildRelease("9.9.9");
    expect(() => verifyRelease({ ...r, publicKeyB64: PUB })).not.toThrow();
  });

  it("rejects a release signed by a different key", () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const r = buildRelease("9.9.9", { signWith: other.privateKey });
    expect(() => verifyRelease({ ...r, publicKeyB64: PUB })).toThrow(/signature does not verify/);
  });

  it("rejects an unsigned release", () => {
    const r = buildRelease("9.9.9", { sign: false });
    expect(() => verifyRelease({ ...r, publicKeyB64: PUB })).toThrow(/signature does not verify/);
  });

  it("rejects an archive whose bytes do not match the signed checksum", () => {
    // signature over SHA256SUMS is valid, but the archive was swapped afterwards
    const r = buildRelease("9.9.9", { tamper: true });
    expect(() => verifyRelease({ ...r, publicKeyB64: PUB })).toThrow(/hash mismatch/);
  });

  it("refuses everything when the build carries no public key", () => {
    const r = buildRelease("9.9.9");
    expect(() => verifyRelease({ ...r, publicKeyB64: "" })).toThrow(/no release public key/);
  });
});

describe("install root detection", () => {
  it("is null when running from a source checkout", () => {
    expect(installRoot()).toBe(null);
  });
});

describe("applying an update", () => {
  /** Lay out an installed copy: launcher + current + versions/<v>/. */
  function makeInstall(version) {
    const root = path.join(tmp, "install");
    fs.mkdirSync(path.join(root, "versions", version), { recursive: true });
    fs.writeFileSync(path.join(root, "current"), `${version}\n`);
    return root;
  }

  it("refuses when the copy is not an installed release", async () => {
    const r = await applyUpdate(repos, { root: null });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_installed");
    expect(r.detail).toMatch(/not an installed release/);
  });

  it("refuses when update checks are disabled", async () => {
    repos = fakeRepos({ updateCheck: false });
    const r = await applyUpdate(repos, { root: makeInstall("0.1.0") });
    expect(r.error).toBe("disabled");
  });

  it("refuses when the release is not newer than the running build", async () => {
    pointAtLocalRelease(repos, "0.0.1");
    const r = await applyUpdate(repos, { root: makeInstall("0.1.0") });
    expect(r.error).toBe("not_newer");
  });

  it("downloads, verifies, installs and repoints without touching the running version", async () => {
    const root = makeInstall("0.1.0");
    const release = buildRelease("9.9.9");
    await serveAssets(release);
    pointAtLocalRelease(repos, "9.9.9");

    const r = await applyUpdate(repos, { root, publicKeyB64: PUB });

    expect(r.ok).toBe(true);
    expect(r.version).toBe("9.9.9");
    expect(r.previous).toBe("0.1.0");
    expect(r.restart).toBe(true);

    // the new version is on disk, complete
    expect(fs.existsSync(path.join(root, "versions", "9.9.9", "routy.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "versions", "9.9.9", "ui", "index.html"))).toBe(true);
    // the pointer moved
    expect(fs.readFileSync(path.join(root, "current"), "utf8").trim()).toBe("9.9.9");
    // and the old version was left alone, so a revert is possible
    expect(fs.existsSync(path.join(root, "versions", "0.1.0"))).toBe(true);
  }, 30_000);

  it("leaves the install untouched when the signature is bad", async () => {
    const root = makeInstall("0.1.0");
    const other = crypto.generateKeyPairSync("ed25519");
    await serveAssets(buildRelease("9.9.9", { signWith: other.privateKey }));
    pointAtLocalRelease(repos, "9.9.9");

    await expect(applyUpdate(repos, { root, publicKeyB64: PUB })).rejects.toThrow(/signature does not verify/);

    expect(fs.existsSync(path.join(root, "versions", "9.9.9"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "current"), "utf8").trim()).toBe("0.1.0");
  }, 30_000);

  it("does not leave a half-extracted version directory behind on failure", async () => {
    const root = makeInstall("0.1.0");
    // a release whose archive verifies but has no payload for the version
    const files = [{ path: "somewhere/else.txt", data: "not the payload" }];
    const tarball = gzip(packTar(files));
    const sums = Buffer.from(`${crypto.createHash("sha256").update(tarball).digest("hex")}  routy-9.9.9.tar.gz\n`);
    await serveAssets({ tarball, sums, signature: crypto.sign(null, sums, privateKey) });
    pointAtLocalRelease(repos, "9.9.9");

    await expect(applyUpdate(repos, { root, publicKeyB64: PUB })).rejects.toThrow(/contains no versions\/9.9.9/);
    expect(fs.existsSync(path.join(root, "versions", "9.9.9"))).toBe(false);
    expect(fs.existsSync(path.join(root, "versions", "9.9.9.incoming"))).toBe(false);
  }, 30_000);
});

describe("release check", () => {
  it("reports no update when github has no release yet", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const s = await checkForUpdate(repos, { force: true, fetchImpl });
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/no releases published yet/);
  });

  it("reports an available update and captures the asset urls", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v9.9.9",
        body: "notes",
        html_url: "https://example/rel",
        assets: [
          { name: "routy-9.9.9.tar.gz", browser_download_url: "https://example/t" },
          { name: "SHA256SUMS", browser_download_url: "https://example/s" },
          { name: "SHA256SUMS.sig", browser_download_url: "https://example/g" },
        ],
      }),
    });
    const s = await checkForUpdate(repos, { force: true, fetchImpl });
    expect(s.latest).toBe("9.9.9");
    expect(s.available).toBe(true);
    expect(s.assetsReady).toBe(true);
    expect(s.notes).toBe("notes");
  });

  it("marks a release without assets as not installable", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v9.9.9", assets: [] }) });
    const s = await checkForUpdate(repos, { force: true, fetchImpl });
    expect(s.available).toBe(true);
    expect(s.assetsReady).toBe(false);
  });

  it("makes no request at all when checks are disabled", async () => {
    repos = fakeRepos({ updateCheck: false });
    let called = false;
    const s = await checkForUpdate(repos, { force: true, fetchImpl: async () => ((called = true), { ok: false }) });
    expect(called).toBe(false);
    expect(s.enabled).toBe(false);
  });

  it("survives an unreachable github", async () => {
    const s = await checkForUpdate(repos, {
      force: true,
      fetchImpl: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/could not reach github/);
  });

  it("serves the cached result instead of re-asking", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ tag_name: "v9.9.9", assets: [] }) };
    };
    await checkForUpdate(repos, { force: true, fetchImpl });
    await checkForUpdate(repos, { fetchImpl }); // no force → within the TTL
    expect(calls).toBe(1);
    expect(updateState(repos).latest).toBe("9.9.9");
  });
});
