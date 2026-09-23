# Per-provider page — design & plan

**Status:** planned (decisions locked 2026-09-23). Not implemented.
**Scope:** P6.1 → P6.3. Backend first, UI second, so each half ships on its own.

## Why

The current Upstreams screen is one flat table plus a `ConnectionsDrawer` side
panel. Three things are impossible from it, and one thing is wrong:

| Want | Today | Gap |
|---|---|---|
| Test **per API key** | `POST /api/nodes/{id}/test` probes `/models` using only `connections[0]` | no per-connection probe, no stored per-key result |
| Test **per model** | — | no way to prove one model id actually serves |
| **Import models** as an explicit, optional action | the node "Test" *silently overwrites* `data.models` | no explicit action, no merge semantics |
| **Manual model id** | — | nowhere to put it that survives an import |
| Dedicated provider page | flat `/upstreams` + drawer | no nested route; the UI has no `useParams` anywhere |

Structural blockers:

- Models live in `node.data.models` — a JSON **string array**, written only by the
  probe. It cannot carry per-model state (source, enabled, last test, latency).
- The model list **does not gate routing**: `<prefix>/<anything>` routes today and
  the list is discovery-only (`GET /v1/models`).

## Locked decisions

1. **Discovery-only.** Routing stays pass-through. The model list drives
   `GET /v1/models` and the UI; nothing done in the UI can break a working client.
   No strict mode for now.
2. **Probes are diagnostics, not traffic.** A key or model test must not write
   `usage_events`, must not move the daily budget, and must not touch the breakers.
   Testing a bad key must never mark a healthy provider as down. Results are stored
   on the key/model row. (Precedent: the existing node probe already bypasses the
   chat handler.)
3. **Tabs:** Models / API Keys / Settings.
4. **Naming:** the UI says **Providers**. The API and DB keep `provider_nodes` —
   label-only change.

## Data model

New table (migration v2):

```sql
CREATE TABLE node_models (
  id               TEXT PRIMARY KEY,
  node_id          TEXT NOT NULL REFERENCES provider_nodes(id) ON DELETE CASCADE,
  model            TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'manual',  -- imported | manual
  enabled          INTEGER NOT NULL DEFAULT 1,
  stale            INTEGER NOT NULL DEFAULT 0,      -- was imported, no longer listed upstream
  last_test_at     TEXT,
  last_test_ok     INTEGER,
  last_test_ttft_ms INTEGER,
  last_test_error  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(node_id, model)
);
CREATE INDEX idx_node_models_node ON node_models(node_id, enabled);
```

`connections` gains no columns — it already has `name`, `credentials`, `status`,
`last_error`, `priority`. Per-key test results reuse `last_error` and add
`last_test_at` / `last_test_ok` / `last_test_ttft_ms` (migration v2, same file).

**Backfill:** at boot, for any node whose `data.models` is a non-empty array and
which has no `node_models` rows, insert them as `source='imported'`. Then leave
`data.models` alone (harmless) so a downgrade does not lose the list. `nodeView`
and `listModels()` switch to reading `node_models`.

`enabled` and `stale` are independent: a model can be disabled by the user *and*
absent upstream. `stale` is cleared by a re-import that lists it again.

## Endpoints

```
GET    /api/nodes/{id}/models                    all rows (incl. disabled/stale)
POST   /api/nodes/{id}/models                    { model, enabled? } → source=manual
PUT    /api/nodes/{id}/models/{modelId}          { enabled?, model? }
DELETE /api/nodes/{id}/models/{modelId}
POST   /api/nodes/{id}/models/import             { connectionId? } → merge
POST   /api/nodes/{id}/models/{modelId}/test     real minimal stream
POST   /api/connections/{id}/test                per-key probe
POST   /api/nodes/{id}/keys/test                 all active keys, bounded concurrency
```

`{modelId}` is the **row id**, not the model string — model ids contain `/`, and
path-encoding them invites bugs.

`import` returns `{ imported, kept, stale }` counts so the UI can report what
changed. It **merges**: manual rows are never touched; imported rows are upserted;
previously-imported rows missing from the response are marked `stale` (never
deleted). A re-import clears `stale` on rows that reappear.

## Probe semantics

Both probes live in a new `core/probe.mjs`, extracted from the inline `probe()` in
`http/api.mjs`, so the node probe, key test and import share one implementation.

| Probe | Request | Proves |
|---|---|---|
| **Key** | `GET <baseUrl>/models` with *that* key | the key is valid and the host is reachable. No tokens. |
| **Model** | `POST <baseUrl>/chat/completions` with `stream:true, max_tokens:1`, read the first SSE frame, abort | auth + model id + streaming, end to end. Yields a real TTFT. Costs a token or two. |

The model probe dispatches through the node's pooled dispatcher (`core/executors/pool.mjs`)
so it exercises the same connection path the proxy uses — but it never calls
`recordFailure`/`recordSuccess` and never calls `recordUsage`.

Which key does a model probe use? The node's first active connection by priority
(same as `pickConnection`), overridable with `?connectionId=` so a specific key can
be blamed.

Bulk key test runs with a small bounded pool (4) so 30 keys neither open 30 sockets
nor serialize into a minute of waiting.

## UI

`/upstreams` list → click a row → `/upstreams/:id` (nested route; the drawer is
retired). Nav and page titles say **Providers**.

**Header:** name · prefix · baseUrl (copyable) · status badge · latency · breaker
state. Actions: Import models · Test all keys · Reset breaker · Disable · Delete.

**Models tab** — `model id | source | enabled | last test (ok · ttft · error) | Test / Disable / Delete`.
Top: **Import from upstream** (optional, clearly not required) and **Add model**
(type an id → Test). Empty state: *"No models yet. Import from the upstream, or add
one by id and test it."*

**API Keys tab** — `label | masked | status | priority | last test | Test / Disable / Delete`.
Top: **Add key** and **Add bulk** — one per line, `label,key` or a bare key (auto
label `key-1…n`), with a *test after adding* toggle and a count preview.

**Settings tab** — the node's own config (prefix, baseUrl, apiType, pricing, pool
tuning, stall budget) — the existing edit modal's fields, inline.

The node-level **Test** button is removed; it becomes **Import models**, which is
what it actually did.

## Phases

| Phase | Deliverable | Gate |
|---|---|---|
| **P6.1** backend | migration v2 + `node_models` repo + backfill + the 8 endpoints + `core/probe.mjs` | tests: merge/stale semantics, probe results persisted, probes leave usage/budget/breakers untouched, routing unchanged |
| **P6.2** UI | nested `/upstreams/:id`, rows become links, detail page with the three tabs, drawer removed, "Providers" naming | browser: add a provider with zero models → type an id → Test → green → it appears in `/v1/models` |
| **P6.3** polish | bulk-test progress, stale surfacing, docs (`configuration.md`, `quickstart.md`) | docs match behaviour |

## Acceptance criteria (P6 gate)

1. A provider with **no** models is fully usable: add a model id by hand, test it,
   and it appears in `GET /v1/models`.
2. Import **merges** — manual rows survive a re-import; vanished imported rows show
   `stale`, not deleted.
3. A per-key test reports **that key's** error without changing the node's status or
   any other key.
4. Bulk add + test 10 keys: every key gets its own result, concurrency bounded.
5. Probes leave `usage_events`, the budget counter and the breakers **untouched**.
6. Routing is unchanged: `<prefix>/<unlisted-model>` still routes.

## Risks

| Risk | Mitigation |
|---|---|
| Model probes cost a token or two | It is an explicit user action; no automatic probing |
| Bulk key test hits a rate limit | Results are per-key, no breaker impact; bounded concurrency; 429 is reported as that key's result |
| `data.models` legacy readers | Boot backfill; old key left intact for one release |
| Nested route + SPA basename | The router basename fix (`/ui` mount) already landed in P4 — `/upstreams/:id` inherits it |
| Scope creep into "strict models" | Explicitly out of scope; revisit only if asked |
