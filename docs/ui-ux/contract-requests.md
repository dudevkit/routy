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
