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
- **Phase:** P2 management API + SPA wiring COMPLETE (44/44 tests; gate loop verified in browser: UI create node → Test Connection 200·6ms·3 models → save → chat flows → usage live). Remaining: 2.4 `re-e init` CLI, Live Console screen (ui-ux scope), P1.6b residuals.
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
| 2026-09-17 | Clone upstream instead of forking workflow | We're studying + remaking, not contributing yet | Fork + PR flow |
| 2026-09-17 | Write master reference + this log before any code | Cross-conversation continuity; every future session starts grounded | — |
| 2026-09-17 | **Project named "RE-E"** — a *re-engineering* (not port, not rewrite) of 9Router; upstream `open-sse/` core is the preserved asset | Terminology sets scope: keep battle-tested core, rebuild packaging around it | port, remake/rewrite, refactor, fork |
| 2026-09-17 | **Two-part split adopted (user proposal):** separate UI-UX from backend. Backend = lean gateway (`/v1/*` + management API + SQLite); UI = dashboard as its own process | Proxy currently welded into Next.js process (dashboard deps on hot path, shared process fate); management-API seam already exists (~100 `/api/*` routes) | keep monolith; full rewrite |
| 2026-09-17 | **v1 feature scope accepted:** §A inference core, §B token savers (RTK keep; headroom/caveman/ponytail throw; pxpipe defer), §C providers+media (media deferred), §E additions (metrics, latency-aware routing, budget caps, config-as-file, `re-e init`, single binary) as proposed; §D delegated to assistant recon-based recommendations **with one user override: proxy pools → KEEP, not throw** | User approved wholesale; proxy pools are a hard requirement | throwing proxy pools |
| 2026-09-17 | **v1 provider scope: zero embedded providers — custom OpenAI-compatible nodes only** (dynamic nodes: `{id, type, name, prefix, apiType, baseUrl}` + API-key connection) | Minimal start; node mechanism covers most API-key upstreams day one; embedded/OAuth providers added later per [provider-catalog.md](./provider-catalog.md) | assistant's ~12-15 provider trim |


## Commitments
- 2026-09-17 (user): **Backend-only focus.** Proceed P0 → P1 (pure backend: harness,
  core MVP gateway). ~~HOLD P2 until the ui-ux worktree agent delivers the UI/UX guide
  and rules~~ → **LIFTED 2026-09-18**: ui-ux delivered (DECISIONS/DESIGN/ia-proposal/
  contract-requests + working `re-e-ui` preview); contract requests folded into
  backend-architecture §5; P2 redefined per ui-ux decisions (roadmap).

## Done

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
- 2026-09-17 (P1.7 + MVP gate): RTK ported (`core/rtk/**`, 17 files, self-contained,
  wired at upstream placement = final body pre-dispatch, default-on, tested: 8KB
  git-diff tool_result compressed end-to-end). L2 fixtures recaptured (capture script
  nonstream case was damaged by an earlier repair — fixed). **MVP GATE: 4/5 L2
  streaming fixtures BYTE-IDENTICAL vs upstream through the live `ree-core`** (openai
  basic+tools, claude basic+tooluse). Residual: nonstream + SSE-lying upstream needs
  sseToJson port = **P1.6b**; real JSON-honoring nodes already correct via passthrough.

## Knowledge Gained

*(Append-only; one line per fact with pointer into reference doc where applicable.)*

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
| 2026-09-17 | Cloned repo; full recon; wrote reference doc + this log; brainstorm delivered; decisions deferred |
| 2026-09-17 | RE-E named; two-part UI/backend split decided; log restructured |
| 2026-09-17 | v1 scope locked (A/B/C/E + D-with-override); provider catalog written; provider scope = compatible nodes only |
| 2026-09-17 | Build plan delivered: roadmap (6 phases/gates/estimates), backend architecture (port map + SSE rewrite spec), DB design (schema v1 + caching + batching). Runtime default Node 22+, "faster" = measurable targets — both pending user veto |
| 2026-09-17 | Parallel-work workflow: UI brainstorm in Orca worktree `ui-ux` (user-driven); ownership split + merge discipline in `docs/ui-ux/brainstorm-brief.md`; log stays single-SSOT |
| 2026-09-17 | P1.5+P1.6: SSE pipeline + chat handler (passthrough byte-parity, bench 16ms parity), translator port (48 files) + claude/responses wiring — L2 claude byte-identical; undici dep for SSRF pinning |
| 2026-09-17 | P1.7 RTK + MVP gate PASSED: 4/5 L2 streaming fixtures byte-identical vs upstream through live ree-core; 34/34 tests; P1.6b residuals logged |
| 2026-09-18 | ui-ux deliverables merged (`82d3316`, 0 conflicts): DECISIONS/DESIGN/ia-proposal/contract-requests + re-e-ui SPA preview (Plex/Phosphor, build verified). Contracts folded into backend-architecture §5; P2 redefined — lean SPA replaces dashboard rewire; re-e-ui on MOCK transport until 2.3 |
| 2026-09-18 | P2.1-2.3: management API (~30 routes) + auth guard + /ui/* static + re-e-ui live transport swap; browser-verified gate loop (create node → test 200·6ms → chat flows → usage live). Remaining: 2.4 CLI, Live Console screen (ui-ux), P1.6b |