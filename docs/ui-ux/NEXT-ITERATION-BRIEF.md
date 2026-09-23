# Next Iteration Brief (from main, 2026-09-18)

> Read this after syncing: `git merge axolotl` from your branch. The merge brings
> you the REAL transport and the live backend. Status + rules below.

## 1. What changed on main since your last sync

- **P1 complete:** routy-core proxy pipeline is done and gate-tested (48/48 tests;
  streaming output byte-identical to upstream 9Router). The gateway runs at
  `127.0.0.1:8010` — proxy at `/v1`, management at `/api`, your SPA served at `/`.
- **P2.1-2.3 complete:** the full management API is live (~30 routes, see
  `docs/backend-architecture.md` §5 — including your 4 contract requests: node test,
  pool test, `/logs/stream` SSE, usage detail fields).
- **Transport swap (P2.3) is done on main:** `src/api/client.ts` = live fetch,
  `src/api/transport.ts` selects live by default (`VITE_API_MODE=mock` still works).
  `hooks.ts` imports from `./transport`. Your preview screens now run against the
  real gateway — vite dev proxy forwards `/api` → `127.0.0.1:8010`.
- **Your identity patch (Plex/Phosphor, Graphite Pro) is merged and kept.**

## 2. Mission: build the remaining screens — against the REAL API

Priority order (highest value first):

1. **Upstreams** — table + edit/delete + per-node Test buttons + Add modal (your
   modal already works live). Real behaviors: `modelCount` is 0 until a Test runs
   (probe caches it); keys come **masked** (`•••` or `prefix…suffix`) — plaintext
   never returns; status is `healthy | degraded | down | disabled` (degraded =
   failures>0 but breaker closed; down = breaker open with expiry).
2. **Usage** — tabs Overview / Details / Quota (DECISIONS: quota lives here).
   Real data shape: `GET /api/usage/stats` → `{requestsToday, tokens7d, costUsd7d,
   errorRatePct, ttftP50Ms}`; `GET /api/usage/failures` → failures with
   `errorCode`; `GET /api/usage/history?since=&limit=`; `GET /api/usage/details`.
   **Fresh install = all zeros** — design the empty state for real.
3. **Live Console** — consume `GET /api/logs/stream` (SSE): `init` event carries a
   200-line snapshot (JSON strings, redacted), then `line` events live. Client-side
   filter by level/tag; parse the JSON for pretty rendering.
4. **Combos & Aliases** — `GET/POST/PUT/DELETE /api/combos`, `GET /api/aliases`,
   `PUT/DELETE /api/aliases/{alias}`. Your DnD builder pattern applies.
5. **Proxy Pools** — CRUD + `POST /api/proxy-pools/{id}/test` (your contract
   request, implemented).
6. **Token Saver + Settings** — `GET/PUT /api/settings` (flat JSON patch);
   `GET/POST/DELETE /api/keys` (POST returns the plaintext key **once**, with a
   `warning` field — design the show-once moment).

## 3. Real-API behaviors to design for (the inconsistencies you were promised)

- No simulated latency — real probes are 5-50ms locally; skeleton states should be
  brief. Empty states are the common case on first run.
- Errors arrive as `{error: {message, detail, retryAfterMs}}` with real status codes.
- `POST /api/keys` is the only plaintext-once surface; everything else is masked.
- Log lines are compact JSON strings (level/tag/msg/data), redacted — parse before
  pretty-printing.
- `GET /api/gateway` tells you the endpoint + masked router key + version — the
  Overview header should read from it, not hardcode.

## 4. Rules (unchanged)

- Own: `docs/ui-ux/**` + `routy-ui/**`. Never edit backend docs — new API needs go
  to `contract-requests.md`.
- Append decisions to `DECISIONS.md`; keep the identity patch (Plex/Phosphor,
  Graphite Pro) consistent across new screens.
- Verify in the headless browser against the live gateway (`127.0.0.1:8010`) —
  the mock (`VITE_API_MODE=mock`) stays as the no-server fallback.
- One caveat from main-session testing: React 19 controlled inputs need
  `InputEvent("input")` (not plain `Event`) if you script interactions.

## 5. Out of scope for this iteration

- `routy init` CLI (backend, landed on main).
- Live Console **backend** (exists); translator debugger (v2, blocked on step-log API).
