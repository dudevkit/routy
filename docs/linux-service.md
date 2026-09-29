# Running routy as a Linux service

`routy` runs in the foreground under `routy serve` — that is the mode a service manager
wants. [`scripts/install-service.sh`](../scripts/install-service.sh) puts it under
systemd: it reads the machine (node's absolute path, the service account's home, the
state directory) instead of asking, writes the unit, enables it at boot, and then waits
for `/api/health` before saying it worked — `systemctl enable --now` returning success
and a gateway that answers are two different claims.

## Install

```bash
# from a checkout
sudo ./scripts/install-service.sh

# with no checkout at all
curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install-service.sh | sudo sh
```

Run it with `sudo`, but as the account that owns the install: a `sudo` caller gets a
service for *their* user and home, not for root.

Then check it:

```bash
systemctl status routy
curl -s localhost:8010/api/health
journalctl -u routy -f
```

### Options

| Flag | Default | What it sets |
| --- | --- | --- |
| `--port N` | `8010` | the port in the unit |
| `--host H` | `0.0.0.0` | bind address; `127.0.0.1` for loopback only |
| `--home DIR` | `~/.routy` | `ROUTY_HOME` — the state directory the service uses |
| `--install-dir DIR` | `~/.local/share/routy` | where `routy.mjs` lives (the launcher the unit runs) |
| `--user NAME` | the `sudo` caller | `User=` / `Group=` on the service |
| `--node PATH` | node from `PATH` | the node binary written into `ExecStart` |
| `--ref REF` | `main` | git ref the unit template is fetched from, when there is no checkout |
| `--dry-run` | | print the unit and change nothing (no `sudo` needed) |
| `--uninstall` | | stop, disable and remove the unit; leaves your data alone |
| `--force` | | install even while something already answers on the port |

`--dry-run` prints the exact unit that would be installed, at no cost and without root —
that is the way to read what you are about to hand `sudo`.

## Changing a running service

Re-run the installer with the flag you want changed. That is the upgrade path, and it is
safe while the gateway is up:

```bash
sudo ./scripts/install-service.sh --port 9000
```

It replaces the unit, reloads systemd, restarts the service, and health-checks the new
port. Two states are worth knowing about, because both are common and neither is
obvious:

- **Something else answers on the port.** Usually a `routy` you started by hand hours
  ago and forgot about. The installer stops before writing anything and says so, instead
  of installing a service that crash-loops on `EADDRINUSE` until you notice.
- **The thing answering is this unit.** Then it is a re-run, not a conflict: the
  installer says it is replacing the unit and restarts it.

## What the unit does, and why

**It runs the launcher, not `versions/<v>/routy.mjs`.** This is the important part.
The launcher is what turns the `current` pointer into a running process, so an update
swaps versions underneath systemd without systemd ever noticing — and a release that
fails to come up is rolled back rather than leaving the service dead. Point the unit
at a version directory and updates will quietly stop working.

**`Restart=on-failure` with `StartLimitBurst=5`.** The launcher already restarts a
crashed gateway with backoff and gives up after 8 tries. The systemd limits are a
second layer, for the case where the *launcher* is the thing dying. Neither layer
retries forever, because a gateway failing for a reason that will not fix itself — a
port already taken, an unreadable database — should stop and be noticed.

**`TimeoutStopSec=20`.** routy drains in-flight streams for up to 10 seconds after
SIGTERM, so a long completion finishes instead of being cut off mid-stream. The
default 90s would work too; 20 keeps `systemctl restart` snappy.

**`ROUTY_HOME` is set explicitly.** `$HOME` is not set for a system service, and the
fallback is whatever the passwd entry says. Without this, a service could quietly use
a different state directory than the `routy` you ran by hand — two databases, and
providers that "disappeared". The installer writes the directory it actually detected
rather than leaving the template's placeholder in place.

**`ROUTY_HOST=0.0.0.0`** is routy's own default, set here so the unit is explicit.
`/api` is behind the bootstrap token for non-loopback peers and `/v1` behind a client
key, so a network bind is not an open gateway. Set `127.0.0.1` for loopback only.

## Node from nvm, volta or asdf

The unit gets node's **absolute** path, so the old `status=203/EXEC` trap is gone:
systemd never resolves `node` through a PATH it does not have, because nothing in the
unit depends on that PATH. What the installer cannot guess is a node that is not on the
PATH of the shell running it — under `sudo` that is root's PATH, not yours:

```bash
sudo ./scripts/install-service.sh --node "$(command -v node)"
```

`--dry-run` prints the resulting `ExecStart=` line, so you can confirm which node the
service will use before installing anything.

## Logs

The gateway writes one JSON object per line to stdout, which systemd captures:

```bash
journalctl -u routy -f                    # follow
journalctl -u routy --since '1 hour ago'  # recent
journalctl -u routy -p warning            # warnings and errors only
```

The Live Console in the dashboard shows the same events, and the database keeps them
for the retention window.

## Updating

Nothing to do. An installed copy checks for a new release at boot and every 6 hours,
and offers it in the dashboard; clicking Update swaps `versions/<v>/` and exits 75,
and the launcher (and therefore systemd) starts the new version. **Do not disable the
service to update** — that is the one way to break the rollback.

## Uninstalling

```bash
sudo ./scripts/install-service.sh --uninstall
sudo rm -rf ~/.local/share/routy ~/.local/bin/routy ~/.routy   # only if you mean it
```

The script stops and disables the unit and removes it. It does **not** touch the state
directory or the install, because "stop the service" and "throw away my providers and
keys" are different requests — the second line is for the second request.

## By hand, if you prefer

The unit ships at [`scripts/routy.service`](../scripts/routy.service) and the installer
exists because those four commands are easy to get subtly wrong, not because they are
impossible:

```bash
sudo curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/routy.service \
  -o /etc/systemd/system/routy.service
sudo sed -i "s|/root/.local/share/routy|$HOME/.local/share/routy|;
             s|/root/.routy|$HOME/.routy|;
             s|^ExecStart=/usr/bin/env node|ExecStart=$(command -v node)|" \
  /etc/systemd/system/routy.service
sudo systemctl daemon-reload
sudo systemctl enable --now routy
```

## Not systemd?

`routy serve` is a well-behaved foreground process: it logs to stdout, drains on
SIGTERM, and exits 75 to mean "a new version is installed, restart me". Any supervisor
that handles those three things works — runit, s6, supervisord, OpenRC, or a
`@reboot` cron line. What you lose without the launcher is the automatic rollback of
a release that fails to start.

If you want boot persistence and nothing else, `systemd` is worth the one command:
it is the only option here that also restarts the gateway when it crashes.
