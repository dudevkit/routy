# RE-E UI → Backend Contract Requests (never edit backend docs directly)

> Main session folds accepted requests into `docs/backend-architecture.md` §5 at merge.
> Format: dated entries, each with the UI need, proposed shape, and fallback if rejected.

## 2026-09-17 — Node test + model probe

**UI need:** "Connect upstream in <60s" flow + Upstreams page test buttons.
**Proposed:** `POST /api/nodes/{id}/test` → probes node baseUrl (auth check), returns
`{ ok, latencyMs, models?: string[] }` (models from node's `/v1/models` when reachable).
Used for inline test buttons and model-prefix suggestions in the add-node modal.
**Fallback if rejected:** UI-side probe (CORS-dependent, worse; local UI could hit node
directly but nodes may block browser origins).

## 2026-09-17 — Proxy pool test

**UI need:** Proxy Pools page test + health-check buttons.
**Proposed:** `POST /api/proxy-pools/{id}/test` → `{ ok, latencyMs, error? }`.
Health-check fan-out can stay UI-side (N sequential calls) if backend prefers no bulk
endpoint.
**Fallback:** none — cannot verify pool liveness from the UI without it.

## 2026-09-17 — Live log stream (SSE)

**UI need:** Live Console screen.
**Proposed:** `GET /api/logs/stream` (SSE, session token) — events `init` (ring-buffer
snapshot), `line`, `clear`. Mirrors upstream console-log protocol (inventory §steal).
Optional `?level=` filter server-side; UI filters client-side otherwise.
**Fallback:** polling `GET /api/logs?since=` (higher overhead, still acceptable v1).

## 2026-09-17 — Request detail timing fields

**UI need:** Usage Details drawer ("find slow request in <3 clicks") + TTFT column.
**Proposed:** confirm `/api/usage/details` rows include per-request `ttftMs`,
`durationMs`, `tokensIn/out` (incl. cache read/creation), `nodeId`, `comboId`,
`errorCode`, `requestId`. If the SSE pipeline already captures these (§4), this is a
confirmation, not new work.
**Fallback:** n/a — without TTFT the "slow request" flow degrades to duration-only.

---

## Round 2 — found building the real screens (2026-09-18)

All four round-1 requests shipped and work (`nodes/test`, `proxy-pools/{id}/test`,
`/logs/stream`, usage detail fields). Verified against `127.0.0.1:8010`.

### 1. Node update + enable — `PUT /api/nodes/{id}`

**UI need:** Upstreams is a management screen; today it can create, test, reset and
delete but never rename, fix a typo'd baseUrl, change prefix, or disable a node.
`nodeView` already derives `status: "disabled"` from `node.enabled`, yet nothing can
set `enabled`. **Proposed:** `PUT /api/nodes/{id}` accepting
`{name?, baseUrl?, prefix?, apiKey?, enabled?, apiType?}` → updated `UpstreamNode`.
**Current UI:** no edit affordance shown (deliberate, not missing by accident).

### 2. `usageEventId` on `GET /api/usage/details`

**UI need:** the Details drawer shows a request's raw payload pair next to its
history row. `request_details` has the column, but the route selects
`id, ts, kind, truncated, content` only — so the UI correlates by millisecond
`ts` (works, but ambiguous under concurrency).
**Proposed:** include `usageEventId` in each row, and accept `?usageEventId=`.

### 3. `DELETE /api/connections/{id}` (and priority)

**UI need:** the per-node keys drawer can list and add keys, not revoke one —
the repo has `connections.delete`. Also `priority` is exposed read-only; combo
ordering per node would need `PUT /api/connections/{id}`.

### 4. `PUT /api/keys/{id}` — enable/disable a client key

`repos.apiKeys.setEnabled` exists; no route. Settings shows the key table with a
delete-only action; a revoke/re-enable toggle is the safer default operation.

### 5. Live Console: nothing is logged at the default level

At `info` (the default), a healthy gateway emits **zero** request lines: the
request-path emitters are `log.debug("ROUTE")` (unresolvable only),
`log.debug("RTK")` (on hits), `log.debug("FETCH")` (per upstream call) and
`log.warn("CHAT")` (on node failure). So the console's headline screen is empty
until something goes wrong. Running with `RE_E_LOG_LEVEL=debug` proves the
plumbing is fine — `init` then returned live `{"tag":"FETCH","msg":"demo ← 200
ttft=19ms"}` lines. (My earlier "gateway logs nothing" note was measured against
a process still running at the default level; corrected here.)

Two real gaps remain: `BOOT` goes through `log.raw`, which does not push to the
ring — today's `init` snapshot contained FETCH lines but no BOOT, so a
just-opened console has no provenance for the process it is watching; and there
is no server-side `?level=` or clear, so the console's Clear is view-local only.

**Proposed:** (a) one **info**-level structured line per completed request
`{tag:"REQ", msg:"demo ← 200", data:{requestId, model, nodeId, status, ttftMs,
durationMs, promptTokens, completionTokens}}` — the dashboard should not need
`debug` to show normal traffic; (b) log BOOT via `log.info` so it enters the
ring; (c) `GET /api/logs/stream?level=info`; (d) `POST /api/logs/clear`.

### 6. Bug: `bootstrapToken` is printed in cleartext at boot

```
{"t":"…","level":"info","tag":"BOOT",…,"data":{"bootstrapToken":"ae75b212…"}}
```

Still reproducing on every boot (observed five distinct tokens this evening in
`re-e-core` stdout). `REDACT_KEYS` should cover `bootstrapToken`; the boot record
is evidently bypassing `redact()`. The management token must never reach stdout,
the ring, or `/api/logs/stream`. The UI never displays it.

### 6b. Port already taken → unhandled `EADDRINUSE` throw

Failure mode worth designing for, because it bit us twice tonight: a Windows
process whose supervising wrapper dies leaves the **node child alive holding
8010**; every later launch then dies with a 20-line unhandled
`Error: listen EADDRINUSE` stack and exit 1, which reads like a crash loop of the
gateway itself. For a project whose headline is stability: catch `error` on
`server.listen`, print one human line (`port 8010 already in use — another re-e
gateway is running (pid …)? set RE_E_PORT`), and exit non-zero without a stack.
Bonus: have `GET /api/health` (or the boot line) report its pid so an operator can
tell a live server from a stale supervisor.

### 6c. `requestsToday` day boundary + write lag — please document

Observed: with two requests landing at `2026-09-18T19:12:45Z` (local 2026-09-19
02:12, UTC+7), `requestsToday` returned 0 immediately and 2 ~20 s later, and it
excluded same-UTC-day rows from local 23:xx. So "today" is **local-midnight**
based and reads trail the batched usage write. Both are fine, but the UI labels
this tile "Requests · today" and needs to know which clock it is (and whether to
say "last few seconds may be missing"). Please state the day-boundary rule and the
batch interval in §5.

### 6d. Measured overhead on the live path (informational)

120 sequential `GET /api/health` at 500 ms intervals with UI + stub running:
p50 16 ms, p95 17 ms, max 39 ms, 0 failures, 0 requests >1 s. Nothing to fix —
recorded because the console's earlier apparent stalls were my probe's fault, not
the gateway's.

### 7. Question: combo model-entry semantics

`dev-combo` with `models:["demo/test-model"]`: `POST /v1/… {"model":"dev-combo"}`
→ 200, but `{"model":"dev-combo/test-model"}` → 404 `unresolvable model string`.
The UI's hint says clients call `<combo>/<model>` (from `re-e init` copy). Which is
authoritative? I will phrase the Combos screen hint to match the answer.

### 8. Question: is `GET /v1/models` intentionally unauthenticated?

With `requireApiKey` unset (⇒ enforced for chat), chat returns 401 while
`GET /v1/models` returns the full routable list to any local client. The Combos
screen's model suggestions rely on exactly this. Fine as a loopback design, but I
want it written down before I treat it as a stable seam.

### Transport shapes confirmed (no change requested)

`/api/aliases` returns a map (not an array); `/api/usage/history` rows are raw
snake_case `usage_events` columns plus `at`; probes answer 200 + `ok:false`
(`{ok, latencyMs, modelCount|error}`); errors are
`{error:{message, detail?, path?}}`; 404 for unknown API paths; DELETE → 204.
UI now matches all of these.
