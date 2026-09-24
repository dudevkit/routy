# routy

A lightweight AI gateway. Point OpenAI- and Anthropic-shaped clients at one local
endpoint, and routy routes them to whichever upstream you configure — with health
tracking, fallbacks and a dashboard for the parts that are normally invisible.

```
Claude Code ─┐
Cursor ──────┼──▶  routy :8010  ──▶  provider A
any OpenAI ──┘      /v1/...           provider B  (fallback)
                                      provider C  (cheapest)
```

## Why it exists

Proxies are usually either heavyweight (a framework, a database, a dozen services)
or opaque (a request fails and you have no idea why). routy is small enough to read
in an afternoon and deliberately loud about what it is doing:

- **Zero runtime dependencies** in the published bundle. Node builtins plus `undici`,
  inlined at build time. No native modules, no `better-sqlite3`, no build toolchain
  to run it.
- **One file.** `routy-core/dist/routy.mjs` is ~1.6 MB and boots to ready in ~0.6 s.
  State is a single SQLite database (`node:sqlite`, built in).
- **It tells you what happened.** Every probe reports the *stage* it died at and a
  socket-level timeline; the live console streams every upstream dispatch, retry and
  stream end.

## Features

| | |
|---|---|
| **Formats** | OpenAI ↔ Anthropic translation in both directions, including tool calls and thinking blocks. `/v1/chat/completions`, `/v1/messages`, `/v1/models`. |
| **Routing** | Per-provider prefixes (`mp/gpt-4o`), aliases, and combos with `fastest` / `cheapest` strategies. Unknown model ids pass through — the model list is discovery, never a gate. |
| **Health** | Circuit breakers with exponential backoff (60s → 30min), a stream stall watchdog, and latency memory that routes to the fastest healthy node. |
| **Diagnostics** | Per-model and per-key probes that name the failing stage (`connect` / `headers` / `first-token`) with a socket timeline. Probes never touch usage, budget or breakers. |
| **Budget** | Per-node pricing, a daily spend ceiling, and automatic fallback to unmetered nodes when a metered one would exceed it. |
| **Token saver** | Compresses large tool results in request bodies before they reach the upstream. |
| **Observability** | Prometheus metrics at `/metrics`, a live log console with per-level capture, and request/response capture in the dashboard. |
| **CLI tools** | Detects AI CLIs installed on this machine (Claude Code, Codex, opencode, Droid, Cline, Kilo, Copilot, Hermes, jcode, Grok Build, OpenClaw, DeepSeek TUI) and points them at routy in one click — with a disconnect that restores the config byte-for-byte. |
| **Updates** | An installed copy notices new releases and offers them in the dashboard. Releases are signed; the gateway refuses anything that does not verify. Opt-out, and nothing installs without a click. |

## Install

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install.sh | sh
```

**Windows** (PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/dudevkit/routy/main/scripts/install.ps1 | iex
```

Either one downloads the latest release, **verifies its signature** against the key
compiled into routy, installs to a per-user directory and puts `routy` on your PATH.
Requires **Node 22.5+** (24 recommended).

```bash
routy
```

That starts the gateway and gives you an arrow-key menu — run it in the background,
open the dashboard, copy a client key, restart, and any available update. The default
hands the gateway to the background and gives you your shell back.

It listens on **`0.0.0.0`** and the dashboard works from any device. There is a login —
the default password is `123456`, the way a router's admin page ships with one — and you
enter it once per browser because the session is a cookie. Change it in **Settings**.
Loopback is trusted, so the dashboard on the gateway's own machine is never asked.

Switch the login off in Settings and the dashboard says so in a banner, because anyone
who can reach the port can then read your client keys and edit CLI tool configs.
`ROUTY_HOST=127.0.0.1` keeps it local instead.

**From a release, by hand** — the archive is a self-contained directory:

```bash
tar -xzf routy-0.2.0.tar.gz -C routy && cd routy
node routy.mjs serve          # foreground, no menu (for services and scripts)
```

**From source** — a checkout runs the gateway directly and does not update itself:

```bash
git clone <your-fork> && cd routy
cd routy-ui && npm ci && npm run build && cd ..
cd routy-core && npm ci && npm run build
node server.mjs
```

Then open <http://127.0.0.1:8010>, add a provider on **Providers**, and create a
client key on **Overview**. Point a client at it:

```bash
curl localhost:8010/v1/chat/completions \
  -H "authorization: Bearer sk-..." -H 'content-type: application/json' \
  -d '{"model":"<prefix>/<model>","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Configuration

Defaults live in `config.json` inside the state directory; environment variables
override it.

| Variable | Default | |
|---|---|---|
| `ROUTY_HOME` | `~/.routy` | state directory (`config.json`, `data/routy.db`) |
| `ROUTY_PORT` | `8010` | |
| `ROUTY_HOST` | `0.0.0.0` | bind address. Reachable on your network by default — non-loopback peers need the bootstrap token for `/api` and a client key for `/v1`. `127.0.0.1` keeps it to this machine |
| `ROUTY_LOG_LEVEL` | `info` | `debug` adds every upstream dispatch and stream end |
| `ROUTY_STREAM_IDLE_TIMEOUT_MS` | — | stall watchdog budget; `0` disables |
| `ROUTY_UI_DIR` | — | serve the dashboard from elsewhere |

Common settings (daily budget, whether `/v1` requires a key, capture level) are in
the dashboard and persist across restarts. See [docs/configuration.md](./docs/configuration.md).

## Project layout

```
routy-core/     the gateway — ESM, plain node:http, zero framework
  core/         routing, executors, SSE pipeline, translators, probes, breakers
  db/           node:sqlite driver, migrations, repositories
  http/         management API + Prometheus metrics
routy-ui/       the dashboard — Vite + React + TypeScript + Tailwind
scripts/        install.sh / install.ps1 — the one-liners above fetch these
docs/           configuration, cli-tools, install, linux-service, quickstart, releasing, windows-service
```

The re-engineering notes this was built from — the upstream inventory, the module and
schema designs, the UI/UX working documents, and the golden translator corpus — are
kept in the development tree, not here. See [docs/install.md](./docs/install.md) for
the install and update model.

## Development

```bash
cd routy-core && npm test        # 210 tests
npm run smoke                    # boots the real bundle and drives it, 13 checks
npm run build                    # single-file bundle
```

The stability and performance claims in this README were measured with scripts that
live in the development tree rather than here — a chaos upstream, an overhead
benchmark, and E2E rigs for chat, tool-calling and the updater. They run against a
scratch state directory and a stub upstream, and never touch a real provider.

## Status

Built and used daily, but young — treat it as beta. Known gaps, stated plainly:

- `/v1/messages/count_tokens` and `/v1/embeddings` are not implemented (404).
  Chat, tool calls and streaming are.
- No packaged service installer; on Windows `scripts/routy-task.ps1` registers a
  scheduled task that starts at boot.
- **No release has been published yet**, so the installer and the updater currently
  find nothing. Cutting one is a single command — see [docs/releasing.md](./docs/releasing.md).

## Licence

[MIT](./LICENSE). Portions are derived from other MIT-licensed work — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
