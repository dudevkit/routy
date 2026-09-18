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

### 5. Live Console: the gateway logs almost nothing on a healthy path

Observed on a fresh gateway with traffic flowing: `GET /api/logs/stream` `init`
returned `{"lines":[]}`; only after forcing a node failure did two `warn` CHAT
lines appear. Request-path emitters are `log.debug("ROUTE")` (unresolvable only),
`log.debug("RTK")` (on hits) and `log.warn("CHAT")` (on node failure) — nothing at
`info`, so the console's headline screen looks broken while the gateway is healthy.
Two more details: `BOOT` goes through `log.raw`, which does not push to the ring,
so a just-started gateway reports zero history; and there is no server-side
`?level=` or clear, so the console's Clear is view-local only.

**Proposed:** (a) one info-level structured line per completed request
`{tag:"REQ", msg:"demo ← 200", data:{requestId, model, nodeId, status, ttftMs,
durationMs, promptTokens, completionTokens}}`; (b) log BOOT via `log.info` so the
ring has provenance; (c) `GET /api/logs/stream?level=info`; (d) `POST /api/logs/clear`.

### 6. Bug: `bootstrapToken` is printed in cleartext at boot

```
{"t":"…","level":"info","tag":"BOOT",…,"data":{"bootstrapToken":"b842de88…"}}
```

`REDACT_KEYS` covers authorization/secret/token/password but the key is named
`bootstrapToken` inside `data` — it matches `token`… yet the emitted line shows it
unredacted, so the boot record bypasses `redact()` (it is passed as `extra` to
`log.info`, which does redact — worth re-checking the call site). Either way: the
management token should never reach stdout or the ring. UI never displays it.

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
