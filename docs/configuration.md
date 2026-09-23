# RE-E configuration reference

Precedence, highest first: **environment → `<RE_E_HOME>/config.json` → defaults**.
Everything below is read once at boot; node and settings values are live (they are
read per request).

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `RE_E_HOME` | `~/.re-e` | State directory: `config.json`, `data/re-e.db`, `gateway.lock` |
| `RE_E_PORT` | `8010` | Listen port |
| `RE_E_HOST` | `127.0.0.1` | Bind address. Anything else makes `/api` require the bootstrap token and `/v1` require an API key |
| `RE_E_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `RE_E_UI_DIR` | auto | Dashboard directory. Auto-resolved: `<bundleDir>/ui` → `./re-e-ui/dist` → `../re-e-ui/dist` → `<home>/ui` |
| `RE_E_STREAM_IDLE_TIMEOUT_MS` | `120000` | Stall watchdog budget in ms; `0` disables. Overridable per node |

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
| Model | `POST <baseUrl>/chat/completions` with `stream:true, max_tokens:1` | auth + model id + streaming, end to end. Yields a real TTFT. |

```
POST /api/connections/{id}/test      probe one key
POST /api/nodes/{id}/keys/test       probe every active key (bounded concurrency, 4)
```

A model probe uses the provider's first active key by priority, overridable with
`?connectionId=` so a specific key can be blamed.

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
once it completes). Reset manually with `POST /api/nodes/{id}/reset` or
`POST /api/breakers/{scope}/reset`.

---

## Timeouts and failure modes

| Situation | Behaviour |
|---|---|
| Upstream silent mid-stream | Aborted after the stall budget, client gets a terminal `upstream_stalled` SSE error frame, node counts a failure |
| Upstream silent on a non-streaming body | Same budget; request fails with `upstream_stalled` (502/504) |
| Upstream connection never establishes | 60s connect budget, then `connect_timeout` — no retry, fail over to the next route |
| Every route's breaker open | `503 all_unavailable` with `retryAfterMs` |
| Client disconnects mid-stream | Upstream fetch aborted; the request is recorded as `aborted` |
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

---

## CLI

```
re-e init    connect an upstream, issue a key, point a CLI tool at RE-E
re-e serve   start the gateway (same as: node server.mjs)
re-e key     issue a new router API key (printed once)
```
