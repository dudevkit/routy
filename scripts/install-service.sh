#!/bin/sh
# routy service installer — systemd on Linux.
#
#   sudo ./scripts/install-service.sh
#   curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install-service.sh | sudo sh
#
# docs/linux-service.md has been handing people four commands and two `sed` expressions
# to put the unit in place. That works, and it is how the unit has been installed so far
# — but every one of those substitutions is a place to get the machine wrong, and a
# unit whose ExecStart points at /root/.local/share/routy while ROUTY_HOME points at
# /root/.routy, on a service running as someone else, is a gateway with two databases
# and providers that "disappeared".
#
# This script reads the machine instead of asking: the service account's home from
# passwd, node's absolute path from PATH, the state directory from the same defaults
# the gateway uses. Then it proves the result came up by waiting for /api/health,
# because `systemctl enable --now` returning success is not the same thing as a
# gateway that answers.
#
# scripts/routy.service stays the single source of truth. This script fetches it and
# rewrites only the machine-specific lines, failing loudly when a line it expects is
# missing — so a template edit that drops Environment=ROUTY_PORT breaks the installer
# instead of quietly shipping a unit with a guessed port.
set -eu

REPO="${ROUTY_REPO:-dudevkit/routy}"
REF="${ROUTY_REF:-main}"
UNIT_NAME="routy"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}.service"

PORT="${ROUTY_PORT:-8010}"
HOST="${ROUTY_HOST:-0.0.0.0}"

SUDO_USER_NAME="${SUDO_USER:-}"
RUN_AS="$(id -un)"
NODE_BIN=""
INSTALL_DIR=""
SERVICE_HOME=""
DRY_RUN=0
UNINSTALL=0
FORCE=0

say() { printf '%s\n' "$*"; }
die() { printf 'service: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"; }

usage() {
  cat <<'USAGE'
routy service installer — installs and starts a systemd unit for a routy gateway.

  sudo ./scripts/install-service.sh [options]

  --port N          port the service listens on              (default 8010)
  --host H          bind address                             (default 0.0.0.0)
  --home DIR        state directory for the service          (default <user>/.routy)
  --install-dir DIR routy install directory                  (default <user>/.local/share/routy)
  --user NAME       run the service as this account          (defaults to the sudo caller)
  --node PATH       node binary to run under                 (default: node resolved from PATH)
  --ref REF         git ref the unit template is fetched at  (default main)
  --dry-run         print the unit, change nothing
  --uninstall       stop, disable and remove the unit
  --force           install even if something already answers on the port
  -h, --help        this

Env equivalents: ROUTY_REPO, ROUTY_REF, ROUTY_PORT, ROUTY_HOST, ROUTY_INSTALL_DIR,
ROUTY_HOME, ROUTY_NODE, ROUTY_SERVICE_TEMPLATE.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --home) SERVICE_HOME="${2:?--home needs a value}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
    --user) RUN_AS="${2:?--user needs a value}"; shift 2 ;;
    --node) NODE_BIN="${2:?--node needs a value}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ── who the service runs as ─────────────────────────────────────────────────
# `sudo ./install-service.sh` should install a service for the person who typed it,
# not for root: their install, their state directory, their node. Running as root
# without sudo (a container, a root shell) means root is the intended account.
ENTRY="$(getent passwd "$RUN_AS" 2>/dev/null || true)"
[ -n "$ENTRY" ] || die "no such user: $RUN_AS"
USER_HOME="$(printf '%s' "$ENTRY" | cut -d: -f6)"
USER_GROUP="$(id -gn "$RUN_AS" 2>/dev/null || printf '%s' "$ENTRY" | cut -d: -f4)"
[ -n "$USER_HOME" ] || die "could not read a home directory for $RUN_AS"

INSTALL_DIR="${INSTALL_DIR:-${ROUTY_INSTALL_DIR:-$USER_HOME/.local/share/routy}}"
SERVICE_HOME="${SERVICE_HOME:-${ROUTY_HOME:-$USER_HOME/.routy}}"

# Where to probe. 0.0.0.0 and :: are bind addresses, not reachable ones.
PROBE_HOST="$HOST"
case "$HOST" in
  0.0.0.0|"*") PROBE_HOST="127.0.0.1" ;;
  "::") PROBE_HOST="::1" ;;
esac
BASE_URL="http://$PROBE_HOST:$PORT"

# ── root, and only where it is needed ───────────────────────────────────────
# --dry-run is deliberately allowed without sudo: printing the unit is how you check
# this script before handing it root.
if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
  die "writing $UNIT_PATH needs root — re-run with sudo (or use --dry-run to just look)"
fi
[ "$DRY_RUN" = 1 ] || need systemctl
need curl

# ── uninstall ──────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  if [ ! -f "$UNIT_PATH" ]; then
    say "· no unit at $UNIT_PATH — nothing to remove"
    exit 0
  fi
  # Read the paths back out of the unit rather than recomputing them: the unit is the
  # record of what was installed, and an uninstall that names a different directory than
  # the service actually used is worse than one that names none.
  FROM_UNIT_HOME="$(sed -n 's|^Environment=ROUTY_HOME=||p' "$UNIT_PATH" | head -1)"
  FROM_UNIT_INSTALL="$(sed -n 's|^ExecStart=.* \([^ ]*\)/routy\.mjs serve$|\1|p' "$UNIT_PATH" | head -1)"
  # if/not `[ -n ] &&` — under `set -e` a failing test in an AND-list exits the script,
  # and an uninstall that dies because the unit had no ROUTY_HOME line is a bad trade.
  if [ -n "$FROM_UNIT_HOME" ]; then SERVICE_HOME="$FROM_UNIT_HOME"; fi
  if [ -n "$FROM_UNIT_INSTALL" ]; then INSTALL_DIR="$FROM_UNIT_INSTALL"; fi
  say "· stopping and disabling $UNIT_NAME"
  systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  say ""
  say "$UNIT_NAME removed. The gateway's state in $SERVICE_HOME and the install in"
  say "$INSTALL_DIR are untouched — see docs/linux-service.md to remove those too."
  exit 0
fi

# ── preflight: node ────────────────────────────────────────────────────────
# The unit gets an absolute node path, which is what makes the nvm/volta/asdf
# "status=203/EXEC" trap impossible rather than documented. Under sudo that path is
# resolved from root's PATH, so a per-user node has to be passed in explicitly.
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="${ROUTY_NODE:-}"
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
[ -n "$NODE_BIN" ] || die "node is not on PATH. Pass it: sudo $0 --node /path/to/node"
[ -x "$NODE_BIN" ] || die "$NODE_BIN is not executable"
"$NODE_BIN" -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`service: node 22.5+ is required (found ${process.versions.node}) — routy uses node:sqlite`);
  process.exit(1);
}' || exit 1

# ── preflight: routy is actually installed ─────────────────────────────────
[ -f "$INSTALL_DIR/routy.mjs" ] || die "no routy at $INSTALL_DIR/routy.mjs — install it first:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sh
  (or point at another install with --install-dir)"

# ── preflight: the port ───────────────────────────────────────────────────
# The most common state to install into is a gateway someone already started by hand —
# `routy` in a terminal, still holding the port. Installing over that gives a service
# that crash-loops on EADDRINUSE until the unit is stopped, so say it before touching
# anything instead of letting it surface as a restart loop.
#
# The exception is this unit already being the thing on the port: re-running the
# installer is the documented way to change a port or a state directory, and asking
# for --force to replace your own service would make the normal path the guarded one.
if curl -fsS -m 2 "$BASE_URL/api/health" >/dev/null 2>&1 || curl -fsS -m 2 "$BASE_URL/api/version" >/dev/null 2>&1; then
  if [ "$FORCE" = 1 ]; then
    say "· warning: something already answers on $BASE_URL — the service will fail to bind until it stops"
  elif [ -f "$UNIT_PATH" ] && systemctl is-active --quiet "$UNIT_NAME"; then
    say "· $UNIT_NAME is running and answering on $BASE_URL — replacing the unit and restarting it"
  else
    die "something already answers on $BASE_URL.
  If that is a gateway you started by hand (routy serve in a terminal), stop it first.
  If you want the service on this port anyway, stop that gateway and re-run — or pass
  --force to install the unit while it is still up (it will fail to bind until it stops)."
  fi
fi

# ── the unit ───────────────────────────────────────────────────────────────
# A checkout next to this script wins; otherwise fetch the template, which is what makes
# the curl-one-liner work when there is no checkout at all.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || printf '.')"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

SRC="${ROUTY_SERVICE_TEMPLATE:-}"
if [ -z "$SRC" ] && [ -f "$SCRIPT_DIR/routy.service" ]; then
  SRC="$SCRIPT_DIR/routy.service"
  say "· using the template next to this script"
fi
if [ -z "$SRC" ]; then
  SRC="$TMP/routy.service"
  say "· fetching the template at $REPO@$REF"
  curl -fsSL -m 30 "https://raw.githubusercontent.com/$REPO/$REF/scripts/routy.service" -o "$SRC" \
    || die "could not download scripts/routy.service from $REPO@$REF"
fi

node - "$SRC" "$TMP/routy.service" "$NODE_BIN" "$INSTALL_DIR" "$SERVICE_HOME" "$HOST" "$PORT" "$RUN_AS" "$USER_GROUP" <<'NODE' || die "could not build the unit from $SRC"
const fs = require("node:fs");
const [src, out, nodeBin, installDir, home, host, port, runAs, group] = process.argv.slice(2);
let unit = fs.readFileSync(src, "utf8");

// Fail on a missing line rather than shipping the template's placeholder. A silent
// no-op here is a unit that starts with the wrong state directory — the failure mode
// this script exists to remove.
function setLine(key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (!re.test(unit)) {
    console.error(`  the template has no '${key}=' line — refusing to guess ${value}`);
    process.exit(1);
  }
  unit = unit.replace(re, `${key}=${value}`);
}

setLine("ExecStart", `${nodeBin} ${installDir}/routy.mjs serve`);
setLine("Environment=ROUTY_HOME", home);
setLine("Environment=ROUTY_HOST", host);
setLine("Environment=ROUTY_PORT", port);

// A service running as root when nobody asked for it is a privilege bug; a service
// running as root because that is the account you are in is not.
if (runAs !== "root") {
  if (/^User=/m.test(unit)) {
    unit = unit.replace(/^User=.*$/m, `User=${runAs}`);
    unit = unit.replace(/^Group=.*$/m, `Group=${group}`);
  } else {
    unit = unit.replace(/^\[Service\]\n/m, `[Service]\nUser=${runAs}\nGroup=${group}\n`);
  }
}

fs.writeFileSync(out, unit);
NODE

if [ "$DRY_RUN" = 1 ]; then
  say "· dry run — nothing was written. The unit that would land at $UNIT_PATH:"
  say ""
  cat "$TMP/routy.service"
  exit 0
fi

say "· installing $UNIT_PATH"
if [ -f "$UNIT_PATH" ]; then
  say "  (replacing the existing unit)"
fi
cp "$TMP/routy.service" "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

# --no-pager, and --verify catches a template that systemd itself rejects (a typo in a
# directive name would otherwise only show up as a failure to start).
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$UNIT_PATH" >/dev/null 2>&1 \
    || say "  note: systemd-analyze flags something in the unit — 'systemd-analyze verify $UNIT_PATH' has the detail"
fi

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null
say "· starting $UNIT_NAME"
systemctl restart "$UNIT_NAME"

# ── prove it came up ───────────────────────────────────────────────────────
# enable --now and a running process both look like success; an answering gateway does
# not. 30s is generous because a first boot also checks for updates.
say "· waiting for $BASE_URL/api/health"
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS -m 2 "$BASE_URL/api/health" >/dev/null 2>&1; then
    say ""
    say "routy is serving at $BASE_URL as $RUN_AS."
    say ""
    say "  systemctl status $UNIT_NAME"
    say "  journalctl -u $UNIT_NAME -f"
    say ""
    say "Updates need nothing from you: the service runs the launcher, so a new version"
    say "is picked up on restart without touching this unit."
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

printf 'service: %s did not answer on %s within 30s\n' "$UNIT_NAME" "$BASE_URL" >&2
printf 'service: it is installed and enabled — the last lines of its journal:\n' >&2
journalctl -u "$UNIT_NAME" --no-pager -n 15 2>/dev/null | sed 's/^/  /' >&2 || true
printf 'service: common causes — the port is held by a gateway started by hand, or\n' >&2
printf 'service: ROUTY_HOME points somewhere %s cannot write. See docs/linux-service.md\n' "$RUN_AS" >&2
exit 1
