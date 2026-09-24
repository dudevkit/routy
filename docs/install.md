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

Starts the gateway and shows a menu you drive with the arrow keys:

```
  routy is running
    dashboard  http://192.168.1.50:8010
    endpoint   http://192.168.1.50:8010/v1
               also http://127.0.0.1:8010 on this machine
    state      ~/.routy

  Listening on 0.0.0.0, so other machines can reach it. /api needs the boot
  token, /v1 needs a client key. ROUTY_HOST=127.0.0.1 keeps it local.

  What next?  (↑/↓ then enter)
  ❯ Run in the background and exit
    Open the dashboard
    Show a client key to paste into a CLI tool
    Restart the gateway
    Stop the gateway and quit
```

**Run in the background and exit** is the default. It detaches the gateway and gives
you your shell back, so the gateway outlives the terminal — which is what you want on
a server, and the reason the menu does not block by default.

The gateway listens on **`0.0.0.0`** out of the box, so another machine can use it
without you re-configuring anything first. That is safe to default because the guards
do not depend on the bind address: a non-loopback peer needs the bootstrap token for
`/api` and a valid client key for `/v1`. Set `ROUTY_HOST=127.0.0.1` for loopback only.

`routy serve` starts the same gateway in the foreground with no menu — use that for
a service, a script, or a terminal you want to leave alone. With no terminal attached
(piped input, a service manager) the menu prints once and exits rather than waiting.

## Using the dashboard from another device

Open `http://<server>:8010` from your laptop or phone and you get a login:

```
  Sign in to routy

    password  [            ]
    [ Sign in ]

  Still on the default password: 123456. Change it in Settings once you are in.
```

**The default password is `123456`** — the way a router's admin page ships with one. It
keeps the dashboard reachable from anywhere without a setup step, while still refusing
anonymous access. Change it in **Settings → Access → Dashboard password**.

You enter it **once per browser**: the server sets an `HttpOnly` session cookie, so the
browser sends it from then on, and no script on the page can read it. Changing the
password signs out every other device.

**Loopback is trusted**, so the dashboard on the gateway's own machine is never asked to
sign in to itself.

### What the login protects

Without it, a peer that can reach the port can read your **client API keys** (the
dashboard shows them so you can copy them) and rewrite the **CLI tool configs** on the
machine running routy. They cannot read your provider keys — those are masked — and they
cannot run code, because updates are signature-verified.

### Turning the login off

**Settings → Access → Require a login for the dashboard.** With it off the dashboard
shows a banner and the boot log says so once, because the exposure above is then real
and unmitigated:

```
listening on the network with the management API unlocked
  anyone who can reach this port can read client keys and edit CLI tool configs
```

`ROUTY_HOST=127.0.0.1` is the other way to make the question moot: bind loopback, and
nothing outside the machine can reach the management API at all.

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
