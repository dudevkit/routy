# routy configuration reference

Precedence, highest first: **environment → `<ROUTY_HOME>/config.json` → defaults**.
Everything below is read once at boot; node and settings values are live (they are
read per request).

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `ROUTY_HOME` | `~/.routy` | State directory: `config.json`, `data/routy.db`, `gateway.lock` |
| `ROUTY_PORT` | `8010` | Listen port |
| `ROUTY_HOST` | `127.0.0.1` | Bind address. Anything else makes `/api` require the bootstrap token and `/v1` require an API key |
| `ROUTY_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ROUTY_UI_DIR` | auto | Dashboard directory. Auto-resolved: `<bundleDir>/ui` → `./routy-ui/dist` → `../routy-ui/dist` → `<home>/ui` |
| `ROUTY_STREAM_IDLE_TIMEOUT_MS` | `120000` | Stall watchdog budget in ms; `0` disables. Overridable per node |

## `config.json`

```json
{
  "port": 8010,
  "host": "127.0.0.1",
  "logLevel": "info",
  "streamIdleTimeoutMs": 120000,
  "retention": {
    "detailsDays": 7,
    "detailsMaxRows": 50000,
    "usageDays": 90,
    "usageMaxRows": 500000
  }
}
```

`retention` merges per key, so a partial object keeps the other defaults. The sweep
runs at boot and hourly.

---

## Settings (live, via `PUT /api/settings`)

| Key | Default | Meaning |
|---|---|---|
| `requireApiKey` | `true` | `/v1` needs a client key from non-loopback peers. Loopback is trusted |
| `rtkEnabled` | `true` | RTK token saver: compresses large `tool_result` payloads (diffs, build output, file listings) before dispatch |
| `budgetUsdPerDay` | `0` | Hard daily ceiling on **metered** spend. `0` = unlimited |
| `logLevel` | `info` | What the gateway records: `debug` adds every upstream dispatch/response/retry/stream-end. Applied live and persisted |

### Budget behaviour

Metered spend is the sum of `cost_usd` over nodes that carry a price. When today's
spend reaches the ceiling, metered routes are dropped before dispatch; if nothing
unmetered is left the request fails with:

```json
{ "error": { "message": "budget_exceeded", "spentUsd": 5.02, "limitUsd": 5, "retryAfterMs": 28800000 } }
```

Because unpriced nodes are unmetered, an exhausted budget naturally falls through to
a free or local upstream instead of breaking the request. Spend resets at local
midnight. `GET /api/usage/stats` returns `costUsdToday` from the same counter the
enforcement uses.

---

## Nodes

`POST /api/nodes` (and `PUT /api/nodes/{id}`) accept a `data` object. It **merges**
on update, so editing one field never drops the others.

| `data` key | Meaning |
|---|---|
| `pricing` | `{ "inputPer1M": 3, "outputPer1M": 15 }` in USD. Absent/null = unmetered |
| `streamIdleTimeoutMs` | Stall watchdog budget for this node; `0` disables |
| `probeTimeoutMs` | Budget for a model probe; default 45000. Reasoning models on free tiers routinely need 5-30s to a first token |
| `pool` | Upstream connection pool: `connections` (64), `pipelining` (1), `keepAliveTimeoutMs` (60000), `keepAliveMaxTimeoutMs` (600000), `noDelay` (true) |
| `retry` | Per-status retry overrides, e.g. `{ "503": { "attempts": 0 } }`. Defaults mirror upstream 9Router: 502 → 3×3s, 503 → 3×2s, 429 → no retry (fall back instead); `Retry-After` is honoured |

The model list used to live in this blob; it has its own table now — see **Models**.
A provider is addressed as `<prefix>/<model>`; see **Models** and **Probes** for the
per-model and per-key testing surface.

### Connection pooling

One pool per upstream **origin** (not per node), so two nodes on the same host share
sockets. This matters more than it looks: Node's built-in `fetch` dispatcher costs
~15ms per loopback request in connection churn, against ~0.4ms pooled. `connections`
is deliberately generous (64) — a queued request is added latency — but bounded so
one origin cannot exhaust the process.

---

## Models

Each provider keeps its own model list. It is **discovery-only**: it drives
`GET /v1/models` and the dashboard, and routing still passes any
`<prefix>/<model>` through untouched. Nothing you do to the list can break a
client that is already working.

| `node_models` field | Meaning |
|---|---|
| `model` | the id as the provider expects it |
| `source` | `manual` (typed by you) or `imported` (came from the provider's `/models`) |
| `enabled` | listed in discovery, or parked without deleting |
| `stale` | was imported and the provider no longer lists it — kept and marked, never silently deleted |
| `last_test_*` | outcome of the last probe of this model |

**Import is optional.** `POST /api/nodes/{id}/models/import` fetches the provider's
list and **merges**: manual rows are never touched, imported rows are upserted, and
imported rows missing from the response become `stale`. A row that reappears has
`stale` cleared. You can equally just add an id by hand and test it.

```
GET    /api/nodes/{id}/models                    all rows (incl. disabled/stale)
POST   /api/nodes/{id}/models                    { model, enabled? } → source=manual
PUT    /api/nodes/{id}/models/{modelId}          { enabled?, model? }
DELETE /api/nodes/{id}/models/{modelId}
POST   /api/nodes/{id}/models/import             { connectionId? } → merge
POST   /api/nodes/{id}/models/bulk               { ids[], action } → hide|show|delete|test
POST   /api/nodes/{id}/models/{modelId}/test     real one-token stream
```

`{modelId}` is the row id, not the model string — model ids contain `/`.

`bulk` acts on a selection in one round trip, with every id scoped to that provider
(an id belonging to another provider is ignored, not acted on). `test` runs with
bounded concurrency (4) so a 60-model selection does not open 60 sockets. The
dashboard's Models tab drives all of this: a copy button on each row (copies the
routable `<prefix>/<model>`), and a **Select** mode with select-all plus Test /
Hide / Show / Delete over the selection.

---

## Probes (testing keys and models)

Probes are **diagnostics, not traffic**. They write their result on the key or model
row and never touch `usage_events`, the daily budget, or the breakers. Testing a
deliberately-bad key therefore cannot mark a healthy provider as down, and a
one-token ping cannot move your error rate or spend your budget.

| Probe | Request | Proves |
|---|---|---|
| Key | `GET <baseUrl>/models` with **that** key | the key is valid and the host is reachable. No tokens. |
| Model | `POST <baseUrl>/chat/completions` with `stream:true, max_tokens:1024` | auth + model id + streaming, end to end. Yields a real TTFT. |

```
POST /api/connections/{id}/test      probe one key
POST /api/nodes/{id}/keys/test       probe every active key (bounded concurrency, 4)
```

A model probe uses the provider's first active key by priority, overridable with
`?connectionId=` so a specific key can be blamed. Probes send an `x-ree-probe`
header carrying a short id, which is what lets routy match socket events back to
the probe that caused them; providers ignore it.

**A model probe succeeds at the first token of *any* kind** — content, or any of the
reasoning fields providers use (`reasoning_content`, `reasoning`, `thinking`,
`thinking_content`, `text`, and array-shaped `content`). This matters: reasoning
models stream thinking before they emit an answer, so a probe that waits for the
*answer* reports a healthy model as broken. Observed live on a free-tier reasoning
model: **4s to the first thinking token, 70s to the first answer token.**

`max_tokens` is 1024 rather than 1 for the same reason — a 1-token budget is spent
entirely on chain-of-thought, so the model returns nothing at all (9Router issue
#3010). The probe aborts at the first token, so the larger budget costs nothing.

Timeouts name the **stage** they died at, and carry a socket timeline, because
"timeout" alone tells you nothing:

| Error | Meaning |
|---|---|
| `no socket connected within 45000ms (stage: connect)` | nothing ever connected — network, DNS, TLS, or a refused/queued connection |
| `no response headers within 45000ms (stage: headers)` | the socket connected and the request went out, but the provider never answered |
| `no token within 45000ms (stage: first-token)` | headers arrived, the stream opened, then silence |
| `HTTP 402: Your balance is at $0` | the provider's own message, extracted from its JSON error body |
| `provider error: <msg>` | HTTP 200 with an error envelope in the body |

Every failure also reports `timeline` — the socket events with their offsets, read
from undici's diagnostics channels below the fetch abstraction:

```
timeline: "created@7ms, connected@98ms, error@45005ms"
```

That distinction is the difference between two very different problems. Measured
against a real free tier: the socket connected in 98ms and the headers never came
— a provider-side stall. The older single `stage: connect` label called that a
connection failure and sent you hunting a network problem that did not exist.

Budget: `node.data.probeTimeoutMs`, default 45s.

A stored result is a **snapshot, not a live state**, and the UI shows how old it is
next to every verdict. When probe semantics change — a different timeout, a new
token field, a new success rule — routy bumps an internal probe version and clears
every stored result on the next boot, so an error string the current code can no
longer produce is never displayed as a current failure. `never` is honest; a stale
`timeout after 20000ms` is not.

---

## Watching upstream activity

Probes and upstream dispatch are logged with their own tags, so the Live Console can
be filtered down to them:

| Tag | Level | What |
|---|---|---|
| `PROBE` | info | `→` start (url, budget, key) · `← ok` (ttft, which field carried the token) · `✖` failure (stage, error, elapsed) |
| `UPSTREAM` | debug | `→ POST` (url, model, stream, bytes, timeout) · `← <status>` (content-type, ttfb) · `↻ retry` · `✖` error/abort · `← stream end` (frames, bytes, duration, stalled) |
| `REQ` | info | one line per completed request (status, ttft, tokens, cost) |

**Capture level** decides what the gateway *records*; the console's level chips decide
what you *see*. `info` (default) shows probes and completed requests. Switch to
`debug` — live, from the console's **capture** selector or
`PUT /api/settings {"logLevel":"debug"}` — and every upstream dispatch, response,
retry and stream end is logged too. It persists across restarts, so
"turn on debug → reproduce → read the console" keeps working.

---

## Combos and aliases

An **alias** maps one id to another (`alias → node/model` or another alias; loops are
guarded). A **combo** tries several routes in order, and its `strategy` decides that
order:

| Strategy | Order |
|---|---|
| `fallback` (default) | As declared — what you wrote is what runs |
| `fastest` | By recent TTFT EWMA, per node |
| `cheapest` | By configured price; unmetered nodes first |

Health always dominates: an unhealthy route is never promoted because it is fast or
cheap. Nodes whose latency has not been measured sort **first** so they get probed
once — otherwise an untried node would stay untried forever and a faster upstream
could never be discovered.

---

## Breakers

A node is taken out of rotation after 3 consecutive failures. The cooldown starts at
60s and **doubles** for each further consecutive failure (120s, 240s … capped at
30min); the failure count is reset by any clean response, so a recovered node returns
to the base window. State is persisted and survives a restart.

A stream that dies mid-flight counts as a failure (a response is only "successful"
once it completes). **A client walking away never counts** — a client abort or
disconnect says nothing about the provider's health, so it leaves the breaker
untouched (otherwise your own Ctrl-C could take a healthy provider offline). Reset
manually with `POST /api/nodes/{id}/reset` or `POST /api/breakers/{scope}/reset`.

---

## Timeouts and failure modes

| Situation | Behaviour |
|---|---|
| Upstream silent mid-stream | Aborted after the stall budget, client gets a terminal `upstream_stalled` SSE error frame, node counts a failure |
| Upstream silent on a non-streaming body | Same budget; request fails with `upstream_stalled` (502/504) |
| Upstream connection never establishes | 60s connect budget, then `connect_timeout` — no retry, fail over to the next route |
| Every route's breaker open | `503 all_unavailable` with `retryAfterMs` |
| Client disconnects mid-stream | Upstream fetch aborted; the request is recorded as `aborted`. **Never** counts against the breaker |
| Shutdown (`SIGINT`/`SIGTERM`/`POST /api/gateway/shutdown`) | Stop accepting, drain in-flight streams, drop idle keep-alives, force-close after a 10s grace, then close pools and exit |

---

## Endpoints

| Path | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI shape (also accepts Anthropic-shaped bodies) |
| `POST /v1/messages` | Anthropic shape |
| `GET /v1/models` | Routable ids: node models, aliases, combos |
| `/api/*` | Management API (providers, keys, models, combos, aliases, pools, usage, settings, logs SSE, gateway) |
| `GET /metrics` | Prometheus text. `?windowMs=` narrows the counters |
| `GET /ui/*`, `GET /` | Dashboard |

`/api` and `/metrics` are loopback-or-bootstrap-token. `/v1` is loopback-or-API-key
while `requireApiKey` is on.

Client API keys are `sk-` + 48 alphanumerics. Create them on the **Overview**
page, which is also where they are kept: the list shows each key masked
(`sk-abc1234…wxyz`) and copies the full value on click, so a key is never a
one-shot you have to paste somewhere before the panel closes. The hash does the
authentication lookup; the value is stored only so this page can hand it back,
and is never returned by anything but the loopback management API.

---

## CLI

```
routy init    connect an upstream, issue a key, point a CLI tool at routy
routy serve   start the gateway (same as: node server.mjs)
routy key     issue a new client API key (sk-…; also copyable from the Overview page)
```
