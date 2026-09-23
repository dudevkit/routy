# Axolotl Project Log — Living Document

> **This is the single source of truth for project state.** It MUST be updated after
> every progression: knowledge gained, decision made, commitment taken. If a future
> conversation contradicts this file, this file is stale — fix it, then proceed.
>
> **Update discipline (binding for the assistant):**
> 1. New fact learned about 9Router / our stack → append to **Knowledge Gained**.
> 2. Decision taken (even tentative) → append to **Decision Log** with date + rationale.
> 3. Agreement to do something → add to **Commitments**; done → move to **Done**, never delete.
> 4. Update **Current State** last, so it always reflects the sections above.
>
> Reference doc: [9router-reference.md](./9router-reference.md)

---

## Current State

- **Project:** RE-E — re-engineering of 9Router v0.5.75 into a stable, lightweight, faster gateway.
- **Phase:** P6 COMPLETE — per-provider page landed (113/113 tests; bundle + both live rigs green). P0–P6 done; the remaining menu is optional expansion.
- **Repo:** upstream `decolua/9router` cloned to `./9router/` (main, shallow) — frozen reference.
- **Architecture (agreed):** two-part split — separate UI-UX and backend. Backend first.
- **v1 provider scope:** ZERO embedded providers — custom OpenAI-compatible nodes only
  (user baseUrl + key). Full 122-provider catalog: [provider-catalog.md](./provider-catalog.md).

**Agreed layout (details pending):**
```
axolotl/
├── re-e-core/     # backend: /v1 proxy + management API + db + proxy pools (lean Node service)
├── re-e-ui/       # dashboard, separate process, talks management API only
└── 9router/       # upstream reference (frozen)
```
## Decision Log

| Date | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| 2026-09-23 | **Model list is discovery-only** — routing keeps passing through `<prefix>/<any-model>`; the curated list drives `/v1/models` and the UI. No strict/gating mode | Nothing a user does in the UI can break a working client; gating would be a silent breaking change for every unlisted id | strict-by-default; per-node strict flag (deferred) |
| 2026-09-23 | **Probes are diagnostics, not traffic** — key and model tests write results on their own row, never to `usage_events`, the budget counter, or the breakers | Testing a bad key must not mark a healthy provider down, and a 1-token ping must not move the error rate or spend budget | record probes as real traffic |
| 2026-09-23 | **Per-provider page** with tabs (Models / API Keys / Settings) replaces the `ConnectionsDrawer` | Keys, models and node config are three different concerns with different actions; a drawer cannot carry per-key and per-model test state | keep the drawer; single scrolling page |
| 2026-09-23 | **UI vocabulary: Providers** (API/DB keep `provider_nodes`) | Matches how the user talks about it and 9Router's vocabulary; label-only change, no migration | keep "Upstreams" |
| 2026-09-17 | Write master reference + this log before any code | Cross-conversation continuity; every future session starts grounded | — |
| 2026-09-17 | **Project named "RE-E"** — a *re-engineering* (not port, not rewrite) of 9Router; upstream `open-sse/` core is the preserved asset | Terminology sets scope: keep battle-tested core, rebuild packaging around it | port, remake/rewrite, refactor, fork |
| 2026-09-17 | **Two-part split adopted (user proposal):** separate UI-UX from backend. Backend = lean gateway (`/v1/*` + management API + SQLite); UI = dashboard as its own process | Proxy currently welded into Next.js process (dashboard deps on hot path, shared process fate); management-API seam already exists (~100 `/api/*` routes) | keep monolith; full rewrite |
| 2026-09-17 | **v1 feature scope accepted:** §A inference core, §B token savers (RTK keep; headroom/caveman/ponytail throw; pxpipe defer), §C providers+media (media deferred), §E additions (metrics, latency-aware routing, budget caps, config-as-file, `re-e init`, single binary) as proposed; §D delegated to assistant recon-based recommendations **with one user override: proxy pools → KEEP, not throw** | User approved wholesale; proxy pools are a hard requirement | throwing proxy pools |
| 2026-09-17 | **v1 provider scope: zero embedded providers — custom OpenAI-compatible nodes only** (dynamic nodes: `{id, type, name, prefix, apiType, baseUrl}` + API-key connection) | Minimal start; node mechanism covers most API-key upstreams day one; embedded/OAuth providers added later per [provider-catalog.md](./provider-catalog.md) | assistant's ~12-15 provider trim |


## Commitments
- 2026-09-23 (user): **Per-provider page (P6.1–P6.3).** Dedicated `/upstreams/:id`
  page instead of the drawer, with tabs Models / API Keys / Settings, per-key tests,
  per-model tests, optional model import, and manual model ids. Decisions locked:
  model list stays **discovery-only** (routing keeps passing through), probes are
  **diagnostics only** (no usage/budget/breaker effect), tabs layout, and the UI
  renames Upstreams → **Providers** (API/DB keep `provider_nodes`). Design:
  [provider-page.md](./provider-page.md).
- 2026-09-17 (user): **Backend-only focus.** Proceed P0 → P1 (pure backend: harness,
  core MVP gateway). ~~HOLD P2 until the ui-ux worktree agent delivers the UI/UX guide
  and rules~~ → **LIFTED 2026-09-18**: ui-ux delivered (DECISIONS/DESIGN/ia-proposal/
  contract-requests + working `re-e-ui` preview); contract requests folded into
  backend-architecture §5; P2 redefined per ui-ux decisions (roadmap).

## Done

- 2026-09-23 (client keys: create on Overview, always copyable, OpenAI-shaped): the
  user could not copy their API key — creation lived in Settings behind a show-once
  panel that demanded confirmation ("did you store it?"), and the plaintext was
  rendered exactly once, so the dashboard could never show it again. Moved the whole
  keys card to the **Overview** page, beside the endpoint it authenticates against;
  deleted the show-once panel and its `warning` field. Keys are now **`sk-` + 48
  unbiased base62 chars** (rejection-sampled — `byte % 62` would bias the first 8
  characters) instead of `re_<hex>`. Display stays masked (`sk-abc1234…wxyz`) but
  clicking copies the **full** value, which is what "the dashboard is where I keep
  my key" requires — so migration v3 stores the value next to the hash; the hash
  still does the lookup (indexed equality, no scan), and the value is only ever
  returned by the loopback management API. Keys created before v3 read "not kept"
  and can be deleted/re-created. Verified live: format matches `^sk-[A-Za-z0-9]{48}$`,
  the key still authenticates `/v1/models` (200), it is retrievable from `GET
  /api/keys` later, and the clipboard receives the full key while the chip shows
  the mask. Tests: 128/128, bundle rebuilt (1630 KB, 217 modules), smoke 13/13.

- 2026-09-23 (a timeout that named the wrong cause): the user reported that RE-E
  said `no response within 45000ms (stage: connect)` while Token Harbor's own
  dashboard showed the request completing in 19s. Measured it end to end rather
  than guessing: **the probe was right and the label was wrong.** A socket-level
  trace showed the TCP connection established in 88-98ms and the request written,
  then no response headers ever — a provider-side stall, not a connection failure.
  Four consecutive real probes: 10.6s OK, 33.4s OK, >45s no headers, never
  connected — so the free tier's latency genuinely swings past the budget. Ruled
  out along the way: ALPN (server negotiates h1 when offered), a wedged response
  body (the probe already cancels it), and a keep-alive race (a deterministic
  stub with a 1.5s idle timeout did **not** reproduce a hang, so the pool config
  was left alone). Fixed the actual defect: `stage` is now split into `connect` /
  `headers` / `first-token`, where `connect` means *no socket ever opened* —
  and every failure carries a socket `timeline` (`created@7ms, connected@98ms,
  error@45005ms`) read from undici's diagnostics channels, correlated per probe by
  an `x-ree-probe` id header. Verified live on the user's instance. `PROBE_VERSION`
  → 3 so the old misleading verdicts were invalidated. Tests: 126/126.

- 2026-09-23 (stale probe verdicts outlived the probe that produced them): the user
  asked why `timeout after 20000ms` was still on screen after the probe fix. Because
  a probe result is **stored**, not recomputed — those rows were written at 08:55 by
  the old code, and the UI replayed them as current. Two fixes: (1) `PROBE_VERSION`
  is bumped whenever a probe's *verdict* changes meaning, and boot clears every
  stored model/key result on a version mismatch, so an error string the current code
  can no longer produce is never shown as a live failure; (2) the UI now prints how
  old each verdict is (`2h ago`) and puts the exact time in the tooltip — a snapshot
  that can't say when it was taken reads as a live state. Verified live: after
  restart, 0 models carry a stored result and no `20000ms` string remains anywhere.
  Re-tested the two reported models against the new probe and then **bypassing RE-E
  entirely** — `mimo-v2.6-flash:free` sent no headers in 60s, `qwen3.8-flash:free`
  took 47.3s, so both genuinely exceed the 45s budget: the free tier really is that
  slow, and the honest verdict is a stage-named timeout, not a bug. Tests: 125/125.

- 2026-09-23 (client aborts were degrading healthy providers): the user's provider
  showed `degraded` with `lastError: client_aborted: client aborted` and **zero usage
  rows** — a client abort had been counted as a provider failure. Two paths did it:
  the `!result.ok` branch called `recordFailure` for every error code including
  `client_aborted`, and the non-streaming body read recorded a client abort as
  `upstream_stalled` (the abort rejects `response.text()` exactly like a stall does).
  Three aborts would have opened the breaker — your own Ctrl-C could take a healthy
  provider offline. Client aborts and disconnects now leave the breaker completely
  untouched, and are logged as plain info (`CHAT client aborted ts {afterMs}`) rather
  than a warning. Verified live: abort a request mid-flight → node stays `healthy`,
  `failures: 0`. Tests: 122/122 (abort on the streaming path, abort on the
  non-streaming path, and a genuine upstream 404 that must still count).

- 2026-09-23 (probe correctness + upstream observability): a user-reported "model
  test times out, console shows nothing" turned out to be two real defects.
  **The probe was wrong**, and 9Router's own ping (which the user pointed at) had
  already solved both halves: (1) it only recognised `content`/`reasoning_content`,
  so a reasoning model streaming `reasoning`/`thinking`/`thinking_content` looked
  dead — measured live on a free-tier model: **4s to the first thinking token, 70s to
  the first answer token**, so a probe waiting for the *answer* reports a healthy
  model as broken; (2) `max_tokens: 1` starves a reasoning model entirely (9Router
  issue #3010), so the budget is now 1024 and we abort at the first token of any kind.
  Also borrowed from 9Router: provider-in-body error envelopes, and error text
  extracted from JSON bodies (`HTTP 402: Your balance is at $0` rather than a raw
  blob dump). The probe budget is now `node.data.probeTimeoutMs` (default 45s) and
  **failures name their stage** — `no response within 45000ms (stage: connect)` vs
  `stage: first-token` — because "timeout" alone tells you nothing.
  **The console was blind**: probes logged nothing at all, and `emit()` dropped
  debug lines *before* the ring buffer, so the console could never show upstream
  activity even though its level chips and `?level=` filter were ready. Now `PROBE`
  (info) logs start / ok (ttft + which field carried the token) / failure (stage,
  error, elapsed), and the executor logs a full `UPSTREAM` lifecycle at debug —
  `→ POST` (url, model, stream, bytes, timeout), `← <status>` (content-type, ttfb),
  `↻ retry`, `✖` error/abort, and `← stream end` (frames, bytes, duration, stalled).
  The log level is now a **live, persisted setting** (`PUT /api/settings {logLevel}`)
  with a **capture** selector in the console, so "turn on debug → reproduce → read
  the console" needs no restart. Tests: 119/119 (reasoning-only, finish-only,
  error-in-body, and stage-named timeout cases). Hot path unchanged: overhead p50
  1.3ms / p99 2.8ms, P3 rig 11/11, P4 rig 14/14.

- 2026-09-23 (P6.1 backend): models moved out of `node.data.models` (a JSON string
  array that could not carry per-model state) into a **`node_models` table** —
  `source` (manual|imported), `enabled`, `stale`, and the last probe's
  ok/ttft/error; `connections` gained the same per-key probe columns. Migration v2,
  verified against a **genuine v1 fixture** (build migration 1 only, stamp version
  1, then reopen) rather than by corrupting a v2 database. A boot backfill lifts any
  legacy `data.models` array into rows so nothing is lost.
  **Import merges:** manual rows are never touched, imported rows are upserted, and
  previously-imported rows missing upstream become `stale` — kept and visible, never
  silently deleted; a row that reappears has `stale` cleared. **Probes** moved into
  `core/probe.mjs`: `probeNode` (GET /models), `probeKey` (GET /models with *that*
  key) and `probeModel` (a real `stream:true, max_tokens:1` completion that yields a
  genuine TTFT), plus `mapLimit` for bounded-concurrency bulk key tests. They are
  **diagnostics, not traffic** — no `usage_events`, no budget, no breaker effect
  (asserted in tests). 8 endpoints. `nodeView`/`listModels` read the table; the list
  stays discovery-only, so routing still passes any `<prefix>/<model>` through.
  Two bugs found by testing rather than reading: the connections **list route mapped
  a fixed field set and dropped the probe result** (so a tested key could never show
  as tested — now covered by a regression test), and the batch key endpoint accepted
  only bare `keys[]`, silently discarding the per-line labels the UI advertises (now
  `entries: [{name?, apiKey}]`, with unlabelled keys auto-named).
- 2026-09-23 (P6.2/P6.3 UI): the `ConnectionsDrawer` is gone. Rows in the list are
  links into **`/upstreams/:id`** — a provider page with a header (status, prefix,
  latency, last error) and **Models / API Keys / Settings** tabs. Models tab: an
  optional *Import from provider*, an inline *Add model*, and per-row Test (real
  stream) / hide / delete with source, state and last-test columns. Keys tab: single
  and bulk add (`label,key` per line, optional label prefix, *test each key after
  adding*), *Test all keys*, and a per-key result panel. Settings tab: the provider's
  config plus reset-breaker / disable / delete. The UI now says **Providers**
  throughout (nav, header, copy, empty states); API and DB keep `provider_nodes`.
  Verified in a browser against a scratch instance: a provider with **zero** models
  is usable end to end — type an id, Test, green (40ms real TTFT), and it appears in
  `GET /v1/models`; importing then merged 2 models while keeping the manual row *and
  its test result*; bulk-adding 3 keys honoured `label,key` labels, auto-named the
  bare one and auto-tested all of them. 113/113 tests; the P3 (11/11) and P4 (14/14)
  live rigs still pass against the P6 build.

- 2026-09-23 (P5 packaging): shippable artifact. `scripts/build.mjs` esbuild-bundles
  the CLI + gateway + translator tree + undici into **one ESM file** — 1601 KB
  (798 KB minified), 216 modules inlined, zero runtime dependencies (only Node
  builtins stay external). The build copies `re-e-ui/dist` to `dist/ui` and
  `lib/config.mjs` now resolves `<bundleDir>/ui` via `import.meta.url`, so a
  packaged gateway serves the dashboard with no env var. One non-obvious fix: bundled
  CJS deps (undici) call `require()` for builtins, which esbuild rewrites to
  `__require` — in ESM output that throws `Dynamic require of "node:assert" is not
  supported` unless the bundle carries a `createRequire(import.meta.url)` shim in its
  banner. `scripts/smoke.mjs` is the gate: it boots `dist/re-e.mjs` **from an
  unrelated cwd** (proving no source-tree dependency), checks health/metrics/dashboard
  (from `<bundleDir>/ui`), creates a node, streams a completion, records usage, then
  shuts down through `/api/gateway/shutdown` and asserts exit 0 and the lock released
  — **13/13**. `Dockerfile` is multi-stage (ui → bundle → runtime): the runtime layer
  is `node:24-alpine` carrying only `dist/`, running as `node`, with a healthcheck and
  `/data` volume; `.dockerignore` keeps scratch state out of layers. Docs:
  `docs/quickstart.md` (source / bundle / Docker / Windows task) and
  `docs/configuration.md` (every env var, config key, node `data` knob, combo
  strategy, breaker and timeout behaviour, endpoint auth).
- 2026-09-23 (P5 gate, live): the **built artifact** was driven by the P3 and P4 rigs,
  not the source tree — P3 11/11 (stall watchdog, mid-stream death, 11.4MB stream with
  bounded RSS, 20-way concurrency), P4 14/14 (strategy ordering, metered cost, 402 at
  the ceiling, auto-fallback, all metrics families), and the overhead bench on the
  bundle: **p50 1.4ms / p90 1.5ms / p99 2.7ms, total p50 0ms** — the ≤5ms target holds
  for what actually ships. Docker image build is NOT verified: `docker` is not
  installed on this machine, so the Dockerfile is written but unbuilt.

- 2026-09-23 (P4 speed): the P1 residual is solved. **Root cause** — Node's built-in
  `fetch` runs on Node's *bundled* undici, whose default dispatcher re-establishes
  connections constantly: 15.6ms p50 per loopback request through the gateway vs
  0.4ms with a pooled Agent, flat across p50/p90/p99 and bimodal (0.8ms when a socket
  happened to be reused, which is why it looked like a timer artefact). A v8 Agent
  from the npm package cannot drive the built-in fetch (`UND_ERR_INVALID_ARG` —
  different internal handler interfaces), so the executor now dispatches through npm
  undici's spec `fetch` with a per-origin Agent. Measured overhead: **p50 15.6 → 1.3ms,
  p99 16.1 → 1.7ms, total p50 15.5 → 0.2ms** (targets ≤5ms p50 / ≤15ms p99). 20-way
  concurrency unchanged at 671ms once the connection cap went 16 → 64 (a queued
  request is added latency; a bounded pool still protects the upstream).
  **Routing policy** — combo `strategy` was stored but never used; it now selects
  order: `fallback` (declared), `fastest` (TTFT EWMA), `cheapest` (configured price).
  Health always dominates. Unknown latency sorts *first* (optimistic initialisation) —
  ranking an untried node last would keep it untried forever, so the router could
  never discover a faster upstream; each node is probed once, then ranked on real
  data. **Pricing + budget** — nodes carry `data.pricing`; cost lands on each usage
  row; `settings.budgetUsdPerDay` is a hard ceiling on metered spend, enforced before
  dispatch (402 `budget_exceeded` with `retryAfterMs` to local midnight). Unpriced
  nodes are unmetered, so an exhausted budget automatically falls through to the free
  or local upstream instead of failing. **Observability** — `GET /metrics` (Prometheus
  text): requests by status/node, tokens, cost, TTFT count/sum/min/max, node and
  breaker state, inflight, pools, uptime, process memory. Counters come from
  `usage_events` so the hot path stays untouched; the route is guarded like `/api`.
  **Fixed**: `nodes.update` replaced the whole `data` blob, so editing one field
  (e.g. pricing) silently wiped the cached model list — it now merges. **Fixed**: the
  SPA had no router basename, so `/ui/<route>` deep links fell through to the
  catch-all screen. UI: Spend card (today's spend, daily ceiling, progress) and node
  pricing fields. Tests: metrics (5) + routing policy (14) + budget e2e (4) → 92/92.
- 2026-09-23 (P4 gate, live): `scratch/bench-ree.mjs` (direct vs routed),
  `scratch/p4-verify.mjs` (14/14: strategy ordering, invalid strategy 400, metered
  cost, 402 at the ceiling, auto-fallback to the unmetered node, all metrics
  families), `scratch/p4-fastest.mjs` (3/3: a combo declared slow-first explored the
  slow node once then pinned to the fast one, TTFT 426ms vs 1ms). P3's 11/11 and the
  browser checks were re-run after the executor swap: no regressions.

- 2026-09-23 (P3 stability): hardening pass landed. **Breakers** — exponential
  backoff on consecutive failures (60s → 120s → 240s … capped at 30min), driven by
  the failure count so a failed half-open probe re-opens with a doubled window; a
  clean response resets the ladder to base. Fixed two latent breaker bugs found
  while testing: `breakers.record` silently ignored the absolute `failures` field
  (so `POST /api/nodes/{id}/reset` reset the *state* but never the count), and
  `recordSuccess` fired on response **headers**, so a stream that died mid-flight
  was scored as a success — three consecutive mid-stream deaths never tripped the
  breaker. Success is now recorded only when the response is actually known good
  (clean stream end / body read). **Stream stall watchdog** — `pumpSse` races each
  read against an idle budget (default 120s, `data.streamIdleTimeoutMs` per node,
  `RE_E_STREAM_IDLE_TIMEOUT_MS` globally, 0 disables) and emits a terminal
  `upstream_stalled` error frame instead of hanging the client forever; the same
  budget bounds non-streaming body reads, which previously had **no** read timeout
  at all (headers were bounded, bodies were not). Mid-stream upstream death now
  counts against the breaker too. **Graceful shutdown** — tracks in-flight requests,
  stops accepting, drains running streams, drops idle keep-alives immediately, and
  force-closes after a 10s grace (socket close → clientAbort → upstream abort, so
  the force path stops upstream work rather than orphaning it). **Retention** — boot
  purge became an hourly job covering both `usage_events` (new `usage.purge`) and
  `request_details`, with per-key config overrides under `retention`. **Ops** —
  `POST /api/gateway/shutdown` (202, then drain) because Windows has no SIGTERM;
  `scripts/re-e-task.ps1` + `scripts/re-e-serve.cmd` register the gateway as a
  scheduled task with restart-on-failure, and `docs/windows-service.md` documents
  that plus the NSSM path. First-run bug fixed: a non-existent `RE_E_HOME` crashed
  boot on the lockfile write. Tests: `test/stability.test.mjs` (8) +
  `test/chaos.test.mjs` (8) — 69/69 total.
- 2026-09-23 (P3 gate, live): rig = `scratch/chaos-upstream.mjs` (model name selects
  ok/stall/die/big/slow/long) + `scratch/p3-verify.mjs`. Gateway booted through the
  Windows launcher on :8015 in **317ms** (< 500ms target). **11/11** main checks:
  stall aborts in 1.5s with `upstream_stalled` (bounded, not hung) and the node goes
  `degraded`; mid-stream death yields `upstream_stream_failed`; a slow-but-alive
  stream survives the watchdog (it is a gap budget, not a deadline); an 11.4MB
  stream is delivered in full with **RSS delta 0MB**; 20 concurrent streams all
  complete in 671ms. **Breaker persistence 4/4**: 3 consecutive mid-stream deaths
  trip it → `down` + 503 `all_unavailable`, survives a real process restart, manual
  reset restores `healthy`. **Drain 5/5**: `POST /api/gateway/shutdown` returns 202
  mid-stream, the in-flight 8s stream still delivered **40/40** chunks and its
  `[DONE]`, the process exited 0, and the lockfile was released.

- 2026-09-17: Full recon of 9Router (architecture doc, hot path, db layer, RTK, CLI,
  tests, packaging). Evidence tables in reference doc §13.
- 2026-09-17: Provider catalog generated — all 122 registry entries extracted to
  `docs/provider-catalog.md` (categories, formats, baseUrls, OAuth split, custom
  executor LOC inventory, onboarding checklist). Raw data: `scratch/providers.json`;
  regeneration scripts in `scratch/`. Proxy pools confirmed as kept feature (user).
- 2026-09-17: Build plan written — `docs/roadmap.md` (6 phases, session estimates, gates,
  risk register), `docs/backend-architecture.md` (module/port map, request lifecycle, SSE
  pipeline rewrite spec, API surface, error taxonomy), `docs/db-design.md` (node:sqlite
  + WAL, 12-table schema v1, cache layer, write batching, secrets plan).
- 2026-09-17: UI/UX worktree spun up: `dudevhub/ui-ux` (branch `ui-ux`, child of `axolotl`,
  Orca-managed). Ownership + merge discipline in `docs/ui-ux/brainstorm-brief.md`. First
  RE-E git commit: b8c269b (all docs). `.gitignore` excludes upstream `9router/` clone.
- 2026-09-17 (P0 harness): golden fixture corpus captured — 13 cases (6 request
  translation openai↔claude incl. tools/reasoning; 7 SSE stream cases incl. passthrough,
  tool-calls, thinking) → `tests/golden/fixtures/` (33 files).
- 2026-09-17 (P0 harness): vitest golden suite `tests/golden/` — **13/13 green** against
  upstream v0.5.75. Normalized volatility: `msg_<epoch>` ids, `created` epoch seconds.
- 2026-09-17 (P0 bench): baseline measured — production build, isolated instance
  (DATA_DIR=scratch/bench-data), stub upstream, 40 reqs/stream: direct TTFT p50 ~0-1ms;
  routed TTFT p50/p90/p99 = 16ms; total p50 662 vs 657ms; 40/40 ok. Results:
  `scratch/bench-results.json`.
- 2026-09-17 (P0 done): RTK bench variant — rtk on vs off on 8KB tool_result: TTFT p50
  16→15ms, total identical → RTK processing cost <1ms (free latency-wise). L2 end-to-end
  captures: 5 client-facing fixtures through full pipeline (openai/claude × stream/nonstream
  × tools), verified deterministic across runs after normalization
  (`tests/golden/fixtures-l2/`, capture: `scratch/capture-l2.mjs`). Stub id made
  deterministic; meta timing dropped from fixtures. **P0 gate passed.**
- 2026-09-17 (P1.1): `re-e-core/` skeleton landed — `server.mjs` + `lib/{router,config,log,auth}.mjs`;
  zero runtime deps (Node 22+ builtins only); boots <150ms; `/api/health`, `/api/version`,
  `/v1/models` (empty), 501 stubs for chat endpoints, 404 JSON; structured logging with
  key-redaction + one `log.raw` exception for the management bootstrap token at boot;
  graceful SIGINT/SIGTERM. Running as hub process `ree-core` (:8010).
- 2026-09-17 (P1.2): db layer landed — `db/{driver,migrations,cache,repos}.mjs`: node:sqlite
  pinned (WAL confirmed via -wal file), schema v1 (12 tables from db-design.md), read
  caches with write-invalidation (settings/nodes/connections/combos/aliases), usage
  write-behind queue (flush @250ms or 50 events, re-queue on failure), breakers
  RAM-first with 1s debounced persist, request_details 64KB cap + retention purge at
  boot. 9/9 vitest green (`re-e-core/test/db.test.mjs`). Live `ree-core` boots with db.
- 2026-09-17 (P1.3): routing landed — `core/routing.mjs`: model-string resolution
  (context-marker strip `[1m]` → alias → combo → node prefix), breaker-aware health
  flags (open+unexpired = unhealthy; expired = half-open candidate), `listModels()` for
  /v1/models. 19/19 tests green incl. alias-loop guard and disabled-node exclusion.
  Live-verified: seeded node/alias/combo appear in /v1/models of running `ree-core`
  (`scratch/seed-ree.mjs`; WAL allows second-process seed).
- 2026-09-17 (P1.4): default executor landed — `core/executors/default.mjs`: parity retry
  config (502 3×3s, 503 3×2s, 429 no-retry→fallback, Retry-After honored), stringify-once,
  AbortSignal.any connect timeout (60s default), structured error taxonomy
  (auth_error/rate_limited/upstream_error/network_error/connect_timeout/client_aborted).
  Design note: global fetch used (builtin keep-alive pool) — undici Agent tuning deferred
  to P4, keeps zero-dep. Connect timeout does NOT retry (burned budget → fail fast to
  fallback). 26/26 tests incl. hermetic stub: retries, 429/401 classification, timeouts,
  aborts, /responses URL shape.
- 2026-09-17 (P1.5): SSE pipeline + chat handler landed — `core/sse/{parser,stream}.mjs`,
  `core/handlers/chat.mjs`: byte-safe SSE parser (multi-byte split safe, bounded 1MB
  buffer), pump with backpressure + client-disconnect→upstream abort, LogBuffer (2MB cap,
  counters not accumulation), incremental usage estimation with exact override, terminal
  chunk usage injection (upstream parity; estimator numbers are RE-E's own — normalized
  in golden compares), duplicate-[DONE] parity quirk replicated, breaker fail-fast when
  all routes unhealthy (503 + retryAfterMs), combo fallback, API-key auth, usage+detail
  recording. **33/33 tests. Golden validation: RE-E passthrough output BYTE-IDENTICAL
  to upstream L2 fixture (normalized). Bench: 40/40 ok, TTFT p50 16ms = upstream parity;
  ≤5ms target remains P4 work (residual: ~11-16ms is request handling + undici scheduling,
  possibly Windows timer quantization — investigate in P4).**
- 2026-09-17: Harness gotcha (stub): content-type header was silently lost in an earlier
  stub edit → proxies branching on content-type (incl. RE-E) fell into non-streaming
  path; upstream 9Router was unaffected (no content-type branch) — caught only by
  per-chunk timing test. Lesson: fixture stubs are part of the tested surface.
- 2026-09-17 (P1.6): translator port landed — `core/translate/**` (48 files via
  `scratch/port-translator.mjs`: verbatim translator tree + `deps/` layer: ported
  sessionManager/claudeCloaking/streamHelpers/usageTracking/capabilities/pricing/
  thinkingLevels/visionPatterns/kiroConstants/kiroSessionReplay/mediaConfig/
  defaultThinkingSignature + synthesized runtimeConfig/appConstants/shared/uuid/
  provider(normalizeThinking)/providers(empty)/thoughtSignatureStore(no-op)). Handler now
  translates openai↔claude/responses (`core/sse/translateStream.mjs` mirrors upstream
  stream.js: parse→translate→filter→usage-inject→formatSSE + flush; NO [DONE] in
  translate mode = pinned contract). **L2 parity: claude-client fixtures byte-identical;
  openai passthroughs match. Non-stream+translate deferred P1.6b. `undici` added as
  re-e-core dep for SSRF DNS-pinning in image prefetch only.**
- 2026-09-18 (P2.1-2.3): management API + SPA wiring landed — `http/api.mjs` (~30 routes:
  nodes CRUD + test probe + reset, connections, keys, combos, aliases, proxy-pools + test,
  usage stats/failures/history/details, settings, gateway, breakers reset, `GET /logs/stream`
  SSE with ring-buffer init + live lines + heartbeat). Auth guard: loopback peers pass,
  non-loopback requires bootstrap token (unit-tested). `/ui/*` serves re-e-ui dist with
  SPA fallback. re-e-ui transport swapped mock → live fetch (`client.ts` + `transport.ts`
  selector, dev proxy). **Gate loop verified in browser: UI create node → Test Connection
  200·6ms·3 models (real probe) → save → chat request flows through the UI-created node →
  Overview renders live usage (59 reqs, 99.1K tokens, TTFT p50 16ms) + 2 healthy nodes.**
- 2026-09-19 (model list + batch keys): probe stores full model id list (not just
  count) in `node.data.models`; `GET /api/nodes/{id}/models` returns it; `/v1/models`
  expands real model ids per node prefix (not `prefix/*` wildcards). UI shows model
  chips in the connections drawer. Batch key import: `POST
  /api/nodes/{id}/connections/batch` — takes `keys[]`, creates N connections with
  staggered priority, filters empty strings, returns masked views. UI textarea: one
  key per line in the connections drawer, auto-detects count, button switches between
  "Add Key" / "Add All Keys". Stub PORT made configurable via `STUB_PORT` env.
  52/52 tests. Verified live: all 4 stages green (probe → node view → models api →
  /v1/models expansion).
- 2026-09-19 (ops): zombie respawn loop — the omp broker daemon auto-restarts
  supervised processes even after `taskkill /F`. Fix: kill the BROKER first, then the
  children, then verify the port stays free for 3+ seconds before starting fresh.
  Never trust a port-probe ready check when a zombie might answer it.
- 2026-09-18 (P2 round-2 backend): all 5 accepted contract items implemented —
  `PUT /api/nodes/{id}` (update/enable + key rotation), connections `PUT` (priority/
  status) + `DELETE`, `PUT /api/keys/{id}` (enable/disable), `usageEventId` in details
  (+`?usageEventId=` filter), per-request `REQ` info log line + `?level=` filter +
  `POST /api/logs/clear` (ring clear notifies SSE clients), BOOT ring provenance
  (token excluded — stays stdout-only), `/v1` loopback-or-key guard honoring
  `requireApiKey`. 48/48 tests. Round-2 questions answered in contract-requests.md.
- 2026-09-19 (P2 round-3): all 5 R3 defects fixed + verified live on :8012 scratch —
  R3-1 REQ line scope bug (`log` closure invisible from module-level recordUsage →
  ReferenceError swallowed post-response; now `log` passed as param + regression test),
  R3-2 duplicate prefix → 409 (no more SQLite leaks), R3-3 router errors logged with
  stack, R3-4 disabled node → 503 (semantics confirmed: disabled must not route),
  R3-5 usage event written synchronously returning id → details carry usageEventId,
  R3-6 gateway lockfile (pid-stamped, stale-takeover). Dispositions in ui-ux
  contract-requests.md (committed on their branch `6f1dffb`). NOTE: :8010 currently
  serves the ui-ux worktree's gateway (pre-R3) — after their next sync/restart the
  port returns to current code; port turf rule logged (ops).
- 2026-09-18 (P1.6b + P2.4): `core/sse/sseToJson.mjs` (verbatim parseSSEToOpenAIResponse
  port) — nonstream vs SSE-lying upstream now converts to JSON; L2 nonstream fixture
  structurally identical, ONE documented divergence: upstream overwrites exact upstream
  usage with its buffer-estimate (2050 vs stub's exact 50) — RE-E passes exact usage
  through (strictly better, kept). `detectFormat` body heuristic ported verbatim
  (deps/detectFormat.js) and wired: source = endpoint override || body heuristic.
  `bin/re-e.mjs`: init wizard (upstream + probe + key + Claude Code settings.json
  merge), serve, key. 48/48 tests.
- 2026-09-17 (P1.7 + MVP gate): RTK ported (`core/rtk/**`, 17 files, self-contained,
  wired at upstream placement = final body pre-dispatch, default-on, tested: 8KB
  git-diff tool_result compressed end-to-end). L2 fixtures recaptured (capture script
  nonstream case was damaged by an earlier repair — fixed). **MVP GATE: 4/5 L2
  streaming fixtures BYTE-IDENTICAL vs upstream through the live `ree-core`** (openai
  basic+tools, claude basic+tooluse). Residual: nonstream + SSE-lying upstream needs
  sseToJson port = **P1.6b**; real JSON-honoring nodes already correct via passthrough.

## Knowledge Gained

*(Append-only; one line per fact with pointer into reference doc where applicable.)*

- 2026-09-23: A "show once, copy it now" key panel is hostile when the dashboard is
  where the key is kept. If the product owns the credential, it must be able to
  hand it back; a mask on screen plus a full value on copy is the useful shape.
- 2026-09-23: "Timeout" is not a diagnosis, and naming the wrong stage is worse than
  naming none. "stage: connect" sent the user hunting a network fault while the
  socket had connected in 98ms — measure where the time actually went (socket
  events) before labelling the failure.
- 2026-09-23: A stored diagnostic verdict outlives the code that produced it. When
  probe semantics change, bump a version and invalidate — an error string the current
  code can no longer emit ("timeout after 20000ms") reads as a live failure and sends
  the user chasing a bug that was already fixed.
- 2026-09-23: A snapshot must say when it was taken. Any cached ok/failed badge needs
  an age next to it, or "failed" is indistinguishable from "failed 2 hours ago,
  before the fix".
- 2026-09-23: A circuit breaker must distinguish *who* failed.
  A client abort is not
  upstream ill health; counting it lets a user's Ctrl-C open a healthy provider's
  breaker. Watch for abort errors masquerading as stalls — an aborted fetch rejects
  `response.text()` the same way a dead upstream does.
- 2026-09-23: A "degraded" provider with zero usage rows means a failure was recorded
  on a path that never recorded traffic — a strong hint the failure was not a real
  upstream response.
- 2026-09-23: A "model is slow" probe bug is usually a probe that waits for the wrong
  thing. Reasoning models emit thinking tokens first and the answer much later —
  measured live: **4s to the first thinking token, 70s to the first answer token**.
  Accept a token from *any* reasoning field and the same model looks healthy in 4s.
- 2026-09-23: `max_tokens: 1` is the wrong probe for a reasoning model: the budget is
  spent on chain-of-thought and the model returns nothing (9Router issue #3010, their
  ping uses 1024). Since the probe aborts at the first token, a large budget is free.
- 2026-09-23: "timeout" is not a diagnosis. A probe must say which stage died —
  headers (`connect`) vs stream opened then silent (`first-token`) — or the user has
  no way to tell a network problem from a slow model.
- 2026-09-23: A log ring gated by the same level as stdout cannot ever show debug
  activity, even when the UI has level filters for it. Separate "what is recorded"
  (a live, persisted setting) from "what is displayed" (client-side filters).

- 2026-09-23: A migration test that corrupts a *current* database (drop a table, reset
  the version) does not test migration — it tests re-running DDL that already applied.
  Build the old schema from the old migration, stamp the old version, then open.
- 2026-09-23: A list route that maps a fixed field set will silently drop any field a
  later feature adds. Map through one shared view helper per entity, and test that a
  written field is *readable* through the list, not just through the write response.

- 2026-09-23: esbuild ESM output breaks on bundled CJS deps that `require()` Node
  builtins (`Dynamic require of "node:assert" is not supported`) — the bundle needs a
  `createRequire(import.meta.url)` shim in its banner. Use `const`, not `var`: the
  generated `__require` shim probes `typeof require`, which throws on a TDZ binding.
- 2026-09-23: A packaged Node app should resolve its static assets from
  `import.meta.url`, not `process.cwd()` — esbuild rewrites `import.meta.url` to the
  output file, so `<bundleDir>/ui` works no matter where the process was started.

- 2026-09-23: Node's built-in `fetch` and the npm `undici` package are *different
  copies* with incompatible internals — passing an npm v8 `Agent` as `dispatcher` to
  the built-in fetch fails with `UND_ERR_INVALID_ARG: invalid onRequestStart method`.
  To configure a pool you must dispatch through npm undici's own `fetch`, which is a
  spec `Response` and therefore a drop-in replacement.
- 2026-09-23: Undici's default dispatcher costs ~15ms per request on Windows loopback
  while a pooled Agent costs ~0.4ms, and the distribution is bimodal rather than
  noisy — a socket was reused (fast) or it wasn't (slow). A flat p50≈p90≈p99 delta is
  a good signal for "connection churn", not for timer quantisation.
- 2026-09-23: Measure before theorising about latency: the same `fetch` to the same
  stub was 15ms inside the gateway process and 0.8ms in a bare probe, which localised
  the problem to dispatch config rather than RE-E's own code — after two wrong
  hypotheses (SQLite blocking, Windows timer tick) that the data ruled out.
- 2026-09-23: Ranking unknown-latency routes last makes them permanently untried, so
  the router can never discover a faster upstream. Optimistic initialisation (unknown
  sorts first, so every node gets probed once) is the correct default for
  latency-aware routing.
- 2026-09-23: A JSON config blob needs merge-on-update semantics. `{ ...existing,
  ...patch }` at the top level replaces `data` wholesale, so a UI that edits one field
  silently drops the others (here: the cached model list).

- 2026-09-23: A breaker that resets on response *headers* is worse than no breaker
  for streaming upstreams — every dying stream looks like a success first. Judge
  health at stream end, never at headers.
- 2026-09-23: Node's `fetch` bounds time-to-headers via a signal, but nothing bounds
  the *body* read. Streaming and non-streaming paths both need an explicit idle
  budget; `AbortSignal` alone is not a read timeout.
- 2026-09-23: `res.writeHead()` on a Node http server does not flush — a stub that
  writes headers and then stalls never delivers them, so the client sits in the
  connect phase and a read-timeout test silently tests the connect timeout instead.
  Use `res.flushHeaders()` when the test's point is a stalled body.
- 2026-09-23: Windows PowerShell 5.1 reads BOM-less `.ps1` as the ANSI code page, so
  a UTF-8 em dash (E2 80 94) becomes `â€”` whose 0x94 maps to a smart quote — and
  5.1 accepts smart quotes as string delimiters, breaking the parse several lines
  later. Keep `.ps1`/`.cmd` pure ASCII.
- 2026-09-23: Windows has no SIGTERM for console processes — `taskkill`/`Stop-Process`
  is a hard kill that skips any drain. A gateway-owned shutdown endpoint is the only
  portable graceful-stop primitive; NSSM's Ctrl+C works because Node maps it to SIGINT.

- 2026-09-17: Hot path = `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` →
  executors → `open-sse/utils/stream.js` TransformStream. Framework-agnostic below chat.js.
- 2026-09-17: Persistence already migrated from db.json to SQLite w/ 4-driver fallback;
  zero caching in repos; settings read 2–3×/request.
- 2026-09-17: Translators are registry-based with direct pairs where registered, OpenAI
  pivot otherwise; native passthrough + transport-matching already exist as zero-cost paths.
- 2026-09-17: Tests cover only embeddings (59 tests). Chat path has no safety net.
- 2026-09-17: Background subagent spawning is unavailable in this environment ("No model
  selected" error) — do recon inline, don't fan out.
- 2026-09-17: Upstream ALREADY uses WAL + busy_timeout + synchronous=NORMAL
  (`schema.js:8-16`) — RE-E's DB wins are driver pinning, caching, write batching, not WAL.
- 2026-09-17: Compatible-node baseUrl is read from `connection.credentials.providerSpecificData.baseUrl`
  (`open-sse/executors/default.js:111`), not just node data — node record alone is
  insufficient for routing.
- 2026-09-18 (ops): hub daemon reset orphaned supervised processes — zombies held :8010
  with STALE code while fresh starts died EADDRINUSE (hub's ready.port probe was
  answered by the zombie, masking the failure). Lesson: after daemon resets, kill ALL
  port listeners (netstat → taskkill) and confirm the fresh process's OWN boot log
  before trusting a port-probe ready check.
- 2026-09-18 (ops): port turf war — my supervisor AND the ui-ux agent's supervisor both
  auto-restart a gateway on :8010; whichever respawns last wins and the other dies
  EADDRINUSE. Rule: ONE supervisor owns the gateway port; before starting ree-core,
  confirm no foreign instance holds the port, and the owner must run post-round-2
  code (else UI round-2 calls 404).
| 2026-09-19 | ui-ux visual round merged (`7 commits`: neo skin rebuild per Neuphorism spec, Soft Neumorphic catalog entry H, raised-state redesign 4 variants canvas-locked, error toasts lead with human detail, theme catalog follows app mode). Build verified; gateway restarted; Overview renders live data |
- 2026-09-17: Routed overhead ≈16ms flat (p50≈p90≈p99) through upstream's Next.js prod
  build — contributors: Next route layer + body re-parse + uncached reads. RE-E target
  ≤5ms requires bypassing Next + caching (as planned in backend-architecture).
- 2026-09-17: openai→claude translation injects a Claude Code system prompt
  (CLAUDE_SYSTEM_PROMPT) even with provider=null — fixture-pinned upstream behavior.
- 2026-09-17: Node gotcha (harness): IncomingMessage 'close' fires when request BODY
  completes, not on socket close — use ServerResponse 'close' for stream cleanup.
- 2026-09-17: Bench rig lives in `scratch/` (stub-upstream, seed-bench-db, bench.mjs);
  hub processes `bench-stub` (:20990) + `bench-router` (:20991) kept running for P0 follow-ups.
- 2026-09-17: Upstream source-format detection = endpoint override THEN body heuristic
  (`detectFormat`: claude body shape counts as claude only when model has NO "/" —
  slash = provider routing). RE-E is endpoint-fixed today; both agree on slash-model
  nodes (verified via l2-claude-tooluse). Porting detectFormat for no-slash bodies = P1.6b.
- 2026-09-17: `scratch/port-translator.mjs` = regeneration path for translator re-sync
  after upstream updates; deps shims documented inline with their sources.
- 2026-09-18: React 19 controlled inputs in headless automation: plain `Event("input")`
  does NOT reach onChange — must dispatch `InputEvent("input", {bubbles:true})` after the
  prototype value-setter bypass. Also: Playwright fill/click can hang (8s timeout) on
  modal inputs even with force — evaluate-based interaction is the reliable path here.
- 2026-09-18: The bench stub initially lacked `/models` — the management probe honestly
  reported 404 (probe works against lying upstreams too).

## Open Questions

1. **Approach + UI strategy:** RESOLVED — two-part split; v1 UI = lean SPA rebuild
   (user-ratified in ui-ux; reuse-first dead). P2 management contract = §5 + 4 folded
   contract requests.
2. **Runtime:** RESOLVED by default — Node 22+ (builtin node:sqlite + undici), pending
   user veto. Bun compile remains a P5 packaging experiment.
3. **Provider scope:** RESOLVED 2026-09-17 — zero embedded providers in v1, custom
   OpenAI-compatible nodes only; embedded providers later per provider-catalog.md.
4. "Faster" definition: RESOLVED by default — measurable targets in roadmap §Goals
   (≤5ms p50 overhead, ≤+10ms TTFT, <500ms startup, <150MB idle, bounded buffers),
   pending user veto.

## Session Index

| Date | Summary |
|---|---|
| 2026-09-23 | P6: per-provider page. `node_models` table + migration v2 + legacy backfill; import merges with stale marking; `core/probe.mjs` (key + real-stream model probes, bounded-concurrency bulk); 8 endpoints; drawer replaced by `/upstreams/:id` with Models/API Keys/Settings tabs; UI renamed to Providers. Fixed: connections list dropped the probe result; batch keys discarded per-line labels. 113/113 tests, P3/P4 rigs green |
| 2026-09-23 | P5 packaging: single-file ESM bundle (1.6MB / 798KB minified, 216 modules, zero runtime deps) with a `createRequire` banner shim, `<bundleDir>/ui` asset resolution, `scripts/smoke.mjs` gate (13/13 booting from an unrelated cwd), multi-stage Dockerfile + .dockerignore (unbuilt — no docker on this machine), quickstart + configuration docs. The built artifact passes the P3 rig 11/11, the P4 rig 14/14 and the overhead bench at p50 1.4ms |
| 2026-09-23 | P4 speed: pooled per-origin undici dispatcher (overhead 15.6 → 1.3ms p50, 16.1 → 1.7ms p99 — the P1 residual was Node's built-in fetch connection churn), Prometheus `/metrics`, combo strategies `fastest`/`cheapest` with optimistic latency probing, node pricing + daily budget ceiling with auto-fallback to unmetered nodes, `nodes.update` data-merge fix, SPA router basename fix, UI Spend card + node pricing fields. 92/92 tests |
| 2026-09-23 | P4 gate verified live: 14/14 routing/budget/metrics checks, 3/3 latency-aware routing (combo declared slow-first pinned to the fast node after one probe, 426ms vs 1ms), P3's 11/11 re-run clean after the executor swap, browser-verified Spend card and node pricing (edit preserved the cached model list) |
| 2026-09-23 | P3 stability: breaker exponential backoff + 2 latent breaker bugs fixed (reset ignored `failures`; success recorded at headers so dying streams looked healthy), stream stall watchdog (stream + non-streaming body reads), mid-stream death counts as a breaker failure, graceful drain shutdown, hourly retention job, Windows service story (scheduled-task script + docs + `/api/gateway/shutdown`), fresh-`RE_E_HOME` boot crash fixed. 69/69 tests |
| 2026-09-23 | P3 gate verified live on :8015 (started through the Windows launcher): 11/11 chaos checks, 4/4 breaker-persistence-across-restart, 5/5 graceful-drain (40/40 chunks after shutdown mid-stream, exit 0, lock released). Boot 317ms; RSS delta 0MB on an 11.4MB stream |
| 2026-09-17 | Cloned repo; full recon; wrote reference doc + this log; brainstorm delivered; decisions deferred |
| 2026-09-17 | RE-E named; two-part UI/backend split decided; log restructured |
| 2026-09-17 | v1 scope locked (A/B/C/E + D-with-override); provider catalog written; provider scope = compatible nodes only |
| 2026-09-17 | Build plan delivered: roadmap (6 phases/gates/estimates), backend architecture (port map + SSE rewrite spec), DB design (schema v1 + caching + batching). Runtime default Node 22+, "faster" = measurable targets — both pending user veto |
| 2026-09-17 | Parallel-work workflow: UI brainstorm in Orca worktree `ui-ux` (user-driven); ownership split + merge discipline in `docs/ui-ux/brainstorm-brief.md`; log stays single-SSOT |
| 2026-09-17 | P1.5+P1.6: SSE pipeline + chat handler (passthrough byte-parity, bench 16ms parity), translator port (48 files) + claude/responses wiring — L2 claude byte-identical; undici dep for SSRF pinning |
| 2026-09-17 | P1.7 RTK + MVP gate PASSED: 4/5 L2 streaming fixtures byte-identical vs upstream through live ree-core; 34/34 tests; P1.6b residuals logged |
| 2026-09-18 | ui-ux deliverables merged (`82d3316`, 0 conflicts): DECISIONS/DESIGN/ia-proposal/contract-requests + re-e-ui SPA preview (Plex/Phosphor, build verified). Contracts folded into backend-architecture §5; P2 redefined — lean SPA replaces dashboard rewire; re-e-ui on MOCK transport until 2.3 |
| 2026-09-18 | P2.1-2.3: management API (~30 routes) + auth guard + /ui/* static + re-e-ui live transport swap; browser-verified gate loop (create node → test 200·6ms → chat flows → usage live). Remaining: 2.4 CLI, Live Console screen (ui-ux), P1.6b |
| 2026-09-18 | P1.6b + P2.4: sseToJson + detectFormat ported (L2 nonstream: exact-usage divergence documented as intentional improvement); re-e CLI (init/serve/key) |
| 2026-09-18 | P2 round-2 backend: 5 contract items implemented + 2 questions answered (combo name semantics, /v1/models loopback-or-key guard); zombie-instance incident diagnosed and documented |