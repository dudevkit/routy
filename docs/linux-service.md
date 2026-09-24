# Running routy as a Linux service

`routy` runs in the foreground under `routy serve` — that is the mode a service
manager wants. A unit file ships at [`scripts/routy.service`](../scripts/routy.service).

## Install

```bash
# 1. install routy first, so the paths below exist
curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install.sh | sh

# 2. put the unit in place
sudo curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/routy.service \
  -o /etc/systemd/system/routy.service

# 3. if you are not root, point it at your own install and home
sudo sed -i "s|/root/.local/share/routy|$HOME/.local/share/routy|; \
             s|/root/.routy|$HOME/.routy|; \
             s|^User=.*||" /etc/systemd/system/routy.service
sudo sed -i "/^\[Service\]/a User=$USER" /etc/systemd/system/routy.service

# 4. start it, and start it on boot
sudo systemctl daemon-reload
sudo systemctl enable --now routy
```

Check it:

```bash
systemctl status routy
curl -s localhost:8010/api/health
journalctl -u routy -f
```

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
providers that "disappeared".

**`ROUTY_HOST=0.0.0.0`** is routy's own default, set here so the unit is explicit.
`/api` is behind the bootstrap token for non-loopback peers and `/v1` behind a client
key, so a network bind is not an open gateway. Set `127.0.0.1` for loopback only.

## Node not on systemd's PATH

If node came from nvm, volta or asdf, `/usr/bin/env node` will not find it and the
service fails with `status=203/EXEC`. Use the absolute path:

```bash
sudo sed -i "s|ExecStart=.*|ExecStart=$(which node) /root/.local/share/routy/routy.mjs serve|" \
  /etc/systemd/system/routy.service
sudo systemctl daemon-reload && sudo systemctl restart routy
```

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
sudo systemctl disable --now routy
sudo rm /etc/systemd/system/routy.service
sudo systemctl daemon-reload
rm -rf ~/.local/share/routy ~/.local/bin/routy ~/.routy
```

## Not systemd?

`routy serve` is a well-behaved foreground process: it logs to stdout, drains on
SIGTERM, and exits 75 to mean "a new version is installed, restart me". Any supervisor
that handles those three things works — runit, s6, supervisord, OpenRC, or a
`@reboot` cron line. What you lose without the launcher is the automatic rollback of
a release that fails to start.

If you want boot persistence and nothing else, `systemd` is worth the four commands:
it is the only option here that also restarts the gateway when it crashes.
