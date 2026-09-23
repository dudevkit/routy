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

## Quickstart

Requires **Node 22.5+** (24 recommended — `node:sqlite` needs `--experimental-sqlite`
on 22.5–23.3).

```bash
git clone <your-fork> && cd routy
cd routy-ui && npm ci && npm run build && cd ..     # build the dashboard
cd routy-core && npm ci && npm run build            # bundle to dist/routy.mjs
node dist/routy.mjs serve                           # gateway on :8010
```

Or run from source during development:

```bash
cd routy-core && npm ci && node server.mjs
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
| `ROUTY_HOST` | `127.0.0.1` | loopback only; `0.0.0.0` exposes it to your network |
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
docs/           architecture, configuration, database design, roadmap
rigs/           verification rigs: chaos upstream, benchmarks, E2E and load tests
tests/golden/   byte-exact translator fixtures captured from real upstreams
```

## Development

```bash
cd routy-core && npm test        # 140 tests
npm run smoke                    # boots the real bundle and drives it, 13 checks
npm run build                    # single-file bundle
```

The `rigs/` scripts are how the stability and performance claims were measured —
`p3-verify.mjs` (kill the upstream mid-stream, 20-way concurrency), `p4-verify.mjs`
(overhead), `chat-e2e.mjs` (normal / tool-calling / code generation round trips).
They run against a scratch state directory and a stub upstream, and never touch a
real provider.

## Status

Built and used daily, but young — treat it as beta. Known gaps, stated plainly:

- `/v1/messages/count_tokens` and `/v1/embeddings` are not implemented (404).
  Chat, tool calls and streaming are.
- The Dockerfile is written but has not been built or run.
- No packaged service installer; on Windows `scripts/routy-task.ps1` registers a
  scheduled task that starts at boot.

## Licence

[MIT](./LICENSE). Portions are derived from other MIT-licensed work — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
