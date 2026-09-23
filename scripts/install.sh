#!/bin/sh
# routy installer — macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install.sh | sh
#
# Downloads the latest release, verifies its Ed25519 signature against the key
# compiled into routy, and installs it to ~/.local/share/routy with a launcher on
# PATH. The verification is the point: an installer that skips it hands whoever can
# compromise the release host a way into every machine that runs this.
#
# Node 22.5+ is required — routy runs on node:sqlite — and is used here to do the
# verification, so the check is the same code path the gateway uses on every update
# rather than a second implementation that can drift.
set -eu

REPO="${ROUTY_REPO:-dudevkit/routy}"
INSTALL_DIR="${ROUTY_INSTALL_DIR:-$HOME/.local/share/routy}"
BIN_DIR="${ROUTY_BIN_DIR:-$HOME/.local/bin}"
VERSION="${ROUTY_VERSION:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"; }
need node
need curl
need tar

# ── node version ────────────────────────────────────────────────────────────
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`install: node 22.5+ is required (found ${process.versions.node})`);
  console.error("        routy uses the built-in node:sqlite module.");
  process.exit(1);
}' || exit 1

# ── which release ───────────────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
  say "· finding the latest release"
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.tag_name||"").replace(/^v/,""))}catch{process.stdout.write("")}})')
  [ -n "$VERSION" ] || die "no release found for $REPO. Publish one first, or pin: ROUTY_VERSION=0.2.0"
fi
say "· routy $VERSION"

# Overridable so the installer can be tested against a local server without cutting a
# real release. Same code path, different origin.
BASE="${ROUTY_BASE_URL:-https://github.com/$REPO/releases/download/v$VERSION}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

say "· downloading"
curl -fsSL -o "$TMP/routy.tar.gz" "$BASE/routy-$VERSION.tar.gz" || die "could not download the archive"
curl -fsSL -o "$TMP/SHA256SUMS"   "$BASE/SHA256SUMS"              || die "could not download SHA256SUMS"
curl -fsSL -o "$TMP/SHA256SUMS.sig" "$BASE/SHA256SUMS.sig"        || die "could not download the signature"

# ── verify ──────────────────────────────────────────────────────────────────
# The public key is inlined rather than fetched: a key downloaded alongside the
# thing it verifies proves nothing.
say "· verifying signature"
node - "$TMP" <<'NODE' || die "signature verification FAILED — refusing to install"
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const RELEASE_PUBLIC_KEY = "MCowBQYDK2VwAyEAjummp06F/W5nJsBOvDW6WeCTUjIE9B8vWiGBb4Xc5CM=";

const dir = process.argv[2];
const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"));
const sig = Buffer.from(fs.readFileSync(path.join(dir, "SHA256SUMS.sig"), "utf8").trim(), "base64");
const tarball = fs.readFileSync(path.join(dir, "routy.tar.gz"));

if (!RELEASE_PUBLIC_KEY || RELEASE_PUBLIC_KEY.startsWith("REPLACE_")) {
  console.error("  this installer has no release public key embedded");
  process.exit(1);
}
const key = crypto.createPublicKey({ key: Buffer.from(RELEASE_PUBLIC_KEY, "base64"), format: "der", type: "spki" });
if (!crypto.verify(null, sums, key, sig)) {
  console.error("  the signature does not verify against routy's release key");
  process.exit(1);
}
const expected = sums.toString("utf8").split("\n").map((l) => l.trim().split(/\s+/)).find(([, n]) => n && n.endsWith(".tar.gz"));
if (!expected) {
  console.error("  SHA256SUMS does not list an archive");
  process.exit(1);
}
const actual = crypto.createHash("sha256").update(tarball).digest("hex");
if (actual !== expected[0]) {
  console.error(`  hash mismatch: expected ${expected[0].slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
  process.exit(1);
}
NODE
say "  verified"

# ── install ─────────────────────────────────────────────────────────────────
say "· installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
tar -xzf "$TMP/routy.tar.gz" -C "$INSTALL_DIR"

# The launcher reads `current`; an update unpacks a new versions/<v>/ and repoints
# it, which is why this directory is the thing that gets replaced wholesale.
cat > "$BIN_DIR/routy" <<SHIM
#!/bin/sh
exec node "$INSTALL_DIR/routy.mjs" "\$@"
SHIM
chmod +x "$BIN_DIR/routy"

say ""
say "routy $VERSION installed."
case ":$PATH:" in
  *":$BIN_DIR:"*) say "Run it:  routy" ;;
  *)
    say "$BIN_DIR is not on your PATH. Add it:"
    say ""
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    say ""
    say "Then:  routy"
    ;;
esac
