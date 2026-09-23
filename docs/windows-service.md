# Running routy as a Windows background service

routy is a plain Node process (`routy-core/server.mjs`). Windows has no native way
to run a console program as a service, so there are two supported stories.

Both require **Node 22.5+** on `PATH` (the gateway uses the built-in `node:sqlite`).

---

## Option A — Scheduled task (no extra software)

`scripts/routy-task.ps1` registers a scheduled task with restart-on-failure.
This is the default recommendation: nothing to install, and the gateway starts
with the machine (or with your session).

```powershell
# install (starts at logon for the current user)
powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action install

# install as a machine-wide service (elevated shell; runs as SYSTEM)
powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action install -AtStartup

powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action start
powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action status
powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action stop
powershell -ExecutionPolicy Bypass -File scripts\routy-task.ps1 -Action uninstall
```

Useful flags: `-Port 8010`, `-Home D:\routy-state`, `-RepoRoot C:\src\axolotl`.

The task runs `scripts/routy-serve.cmd`, which sets `ROUTY_HOME`/`ROUTY_PORT` and
then `cd`s into `routy-core` before `node server.mjs`. Task Scheduler settings:
unlimited execution time, restart 5× at 1-minute intervals, start when available,
and don't stop on battery.

### Stopping it cleanly

**Windows has no `SIGTERM`.** Terminating a console process is a hard kill and
skips the drain, which can leave a streaming response truncated and the write
buffer unflushed. So the gateway exposes its own stop route:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8010/api/gateway/shutdown
```

`-Action stop` does exactly this (then stops the task). The handler replies
`202 {"status":"shutting_down"}`, stops accepting connections, lets in-flight
streams finish, and force-closes anything still running after the 10 s grace
period. Loopback callers are trusted; non-loopback callers need the bootstrap
token like every other `/api` route.

Prefer `-Action stop` over `Stop-Process` / `taskkill`.

---

## Option B — NSSM (true service semantics)

Use this when you want the gateway in `services.msc` with real service
start/stop/restart semantics and stdout captured to rotating log files.

```powershell
choco install nssm          # or scoop install nssm
nssm install routy "C:\Program Files\nodejs\node.exe" "C:\src\axolotl\routy-core\server.mjs"
nssm set routy AppDirectory "C:\src\axolotl\routy-core"
nssm set routy AppEnvironmentExtra "ROUTY_HOME=C:\Users\me\.routy" "ROUTY_PORT=8010"
nssm set routy AppStdout "C:\Users\me\.routy\logs\gateway.log"
nssm set routy AppStderr "C:\Users\me\.routy\logs\gateway.err.log"
nssm set routy AppRotateFiles 1
nssm set routy Start SERVICE_AUTO_START
nssm start routy
```

NSSM's stop sends `Ctrl+C` to console programs, which Node surfaces as `SIGINT`
— so `nssm stop routy` already runs the graceful drain path and the shutdown
route above is not needed.

---

## Notes

- **One gateway per data directory.** `server.mjs` writes a pid-stamped
  `gateway.lock` next to the database; a second process pointed at the same
  `ROUTY_HOME` refuses to start and exits `1`. A lock whose pid is dead is taken
  over automatically.
- **State location** defaults to `%USERPROFILE%\.routy` (`config.json`,
  `data/routy.db`, `gateway.lock`). Override with `ROUTY_HOME`.
- **Config precedence** is defaults < `<ROUTY_HOME>/config.json` < environment.
  See `routy-core/lib/config.mjs`; `retention` and `streamIdleTimeoutMs` are the
  keys that matter for long-running hosts.
- **Firewall**: the default bind is `127.0.0.1`. Exposing the gateway on the LAN
  (`ROUTY_HOST=0.0.0.0`) makes the bootstrap token mandatory for `/api`, and
  `/v1` falls back to API-key auth.
