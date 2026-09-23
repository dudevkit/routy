# routy installer - Windows.
#
#   iwr -useb https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install.ps1 | iex
#
# Downloads the latest release, verifies its Ed25519 signature against the key
# compiled into routy, and installs it to %LOCALAPPDATA%\routy with a launcher on
# PATH. The verification is the point: an installer that skips it hands whoever can
# compromise the release host a way into every machine that runs this.
#
# Node 22.5+ is required - routy runs on node:sqlite - and is used here to do the
# verification, so the check is the same code path the gateway uses on every update
# rather than a second implementation that can drift.
#
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a stray non-ASCII
# character corrupts the parse.

$ErrorActionPreference = "Stop"

$Repo       = if ($env:ROUTY_REPO)        { $env:ROUTY_REPO }        else { "dudevkit/routy" }
$InstallDir = if ($env:ROUTY_INSTALL_DIR) { $env:ROUTY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "routy" }
$Version    = $env:ROUTY_VERSION

function Say($msg) { Write-Host $msg }
function Die($msg) { Write-Host "install: $msg" -ForegroundColor Red; exit 1 }

# ---- prerequisites ---------------------------------------------------------
foreach ($cmd in @("node", "tar")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Die "$cmd is required but not on PATH" }
}

# Parsed in PowerShell rather than passed to `node -e`: PowerShell re-quotes native
# command arguments and eats the inner quotes, which silently corrupts the script.
$nodeVersion = (node -v) -replace "^v", ""
$parts = $nodeVersion.Split(".")
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 5)) {
  Die "node 22.5+ is required (found v$nodeVersion). routy uses the built-in node:sqlite module."
}

# ---- which release ---------------------------------------------------------
if (-not $Version) {
  Say "- finding the latest release"
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    $Version = $release.tag_name -replace "^v", ""
  } catch {
    Die "no release found for $Repo. Publish one first, or pin: `$env:ROUTY_VERSION='0.2.0'"
  }
}
Say "- routy $Version"

# Overridable so the installer can be tested against a local server without cutting a
# real release. Same code path, different origin.
$Base = if ($env:ROUTY_BASE_URL) { $env:ROUTY_BASE_URL } else { "https://github.com/$Repo/releases/download/v$Version" }
$Tmp  = Join-Path ([System.IO.Path]::GetTempPath()) ("routy-install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

try {
  Say "- downloading"
  $assets = @(
    @{ file = "routy.tar.gz";    url = "$Base/routy-$Version.tar.gz" },
    @{ file = "SHA256SUMS";      url = "$Base/SHA256SUMS" },
    @{ file = "SHA256SUMS.sig";  url = "$Base/SHA256SUMS.sig" }
  )
  foreach ($a in $assets) {
    try {
      Invoke-WebRequest -Uri $a.url -OutFile (Join-Path $Tmp $a.file) -UseBasicParsing
    } catch {
      Die "could not download $($a.file)"
    }
  }

  # ---- verify --------------------------------------------------------------
  # The public key is inlined rather than fetched: a key downloaded alongside the
  # thing it verifies proves nothing.
  Say "- verifying signature"
  $verifier = Join-Path $Tmp "verify.mjs"
  @'
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
  console.error(`  hash mismatch: expected ${expected[0].slice(0, 12)}..., got ${actual.slice(0, 12)}...`);
  process.exit(1);
}
'@ | Set-Content -Path $verifier -Encoding UTF8

  node $verifier $Tmp
  if ($LASTEXITCODE -ne 0) { Die "signature verification FAILED - refusing to install" }
  Say "  verified"

  # ---- install -------------------------------------------------------------
  Say "- installing to $InstallDir"
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  tar -xzf (Join-Path $Tmp "routy.tar.gz") -C $InstallDir
  if ($LASTEXITCODE -ne 0) { Die "could not extract the archive" }

  # The launcher reads `current`; an update unpacks a new versions/<v>/ and repoints
  # it, which is why this directory is the thing that gets replaced wholesale.
  $shim = Join-Path $InstallDir "routy.cmd"
  "@echo off`r`nnode `"$InstallDir\routy.mjs`" %*" | Set-Content -Path $shim -Encoding ASCII

  # ---- PATH ----------------------------------------------------------------
  # ROUTY_SKIP_PATH is for scripted installs and for anyone who manages PATH
  # themselves; it also keeps a test install from editing the real user PATH.
  if ($env:ROUTY_SKIP_PATH -eq "1") {
    Say "  skipped PATH setup (ROUTY_SKIP_PATH=1)"
  } else {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
      [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
      Say ""
      Say "Added $InstallDir to your PATH. Open a new terminal for it to take effect."
    }
  }

  Say ""
  Say "routy $Version installed."
  Say "Run it:  routy"
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
