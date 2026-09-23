# Installing routy

## One command

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install.sh | sh
```

**Windows** (PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install.ps1 | iex
```

Then:

```bash
routy
```

Requires **Node 22.5+** — routy stores its state in the built-in `node:sqlite`.
On Node 22.5–23.3 that module needs `--experimental-sqlite`; Node 24 is recommended.

## What the installer does

1. Finds the latest release on GitHub (or uses `ROUTY_VERSION` if you pin one).
2. Downloads the archive, `SHA256SUMS`, and `SHA256SUMS.sig`.
3. **Verifies the signature** against the Ed25519 public key compiled into routy,
   then the archive against the signed checksums.
4. Extracts to a per-user directory and puts `routy` on your PATH.

**Nothing is installed if the signature does not verify.** The public key is inlined
in the installer rather than fetched: a key downloaded alongside the thing it
verifies proves nothing.

The verification runs in Node, which is already required — so the installer uses the
same code path the gateway uses on every update rather than a second implementation
that can drift.

| | install directory | launcher |
|---|---|---|
| macOS / Linux | `~/.local/share/routy` | `~/.local/bin/routy` |
| Windows | `%LOCALAPPDATA%\routy` | `routy.cmd` in the same directory |

## What gets installed

```
routy.mjs          the launcher — never replaced by an update
current            a text file naming the version to run
versions/<v>/      routy.mjs + ui/ for that version
```

An update unpacks a **new** `versions/<v>/` and rewrites `current`. Nothing running
is ever overwritten — which is what makes self-update work on Windows, where a
running `.mjs` cannot be replaced — and it makes a bad release reversible: if the new
version exits within 15 seconds, the launcher reverts to the previous one.

## The first run

```
routy
```

Starts the gateway and shows a menu:

```
  routy is running
    dashboard  http://127.0.0.1:8010
    endpoint   http://127.0.0.1:8010/v1
    state      ~/.routy

  What next?
    1) Open the dashboard
    2) Show a client key to paste into a CLI tool
    3) Restart the gateway
    4) Quit
```

`routy serve` starts the same gateway in the foreground with no menu — use that for
a service, a script, or a terminal you want to leave alone. With no terminal attached
(piped input, a service manager) the menu prints once and exits rather than waiting.

## Environment variables

| | |
|---|---|
| `ROUTY_VERSION` | install a specific version instead of the latest |
| `ROUTY_INSTALL_DIR` | where to install (default above) |
| `ROUTY_BIN_DIR` | where to put the launcher (Unix) |
| `ROUTY_SKIP_PATH=1` | do not touch PATH (Windows) |
| `ROUTY_NO_OPEN=1` | never open a browser from the menu |
| `ROUTY_REPO` | install from a fork |

## Updating

An installed copy checks for a newer release at boot and every six hours, and offers
it in the dashboard and in the menu. Updates are signed and verified the same way the
install was; nothing installs without a click. See [releasing.md](./releasing.md).

Turn the check off with `updateCheck: false` in settings, or the toggle on the
**Settings** page — when it is off, **no request is made at all**.

## Uninstalling

```bash
# macOS / Linux
rm -rf ~/.local/share/routy ~/.local/bin/routy

# Windows
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\routy"
```

That leaves your state — providers, keys, usage — in `~/.routy` (`ROUTY_HOME`).
Delete that too if you want a clean slate.

## Why not npm or Docker

**npm** would give routy a second updater with a different trust model. The whole
update story is "the gateway refuses anything that does not verify against the key
compiled into it" — an npm-installed routy would be updated by npm instead, bypassing
that. routy also has zero runtime dependencies, so npm buys nothing.

**Docker** cannot run routy's most useful feature. CLI Tools detects binaries on your
`PATH` and writes your `~/.claude/settings.json`, `~/.codex/config.toml` and so on —
inside a container there is no host filesystem to reach, so detection finds nothing
and writes go nowhere. It would work as a plain proxy with the dashboard's best
feature disabled.
