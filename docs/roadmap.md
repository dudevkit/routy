# RE-E Build Roadmap

> **Status:** Active plan. Companion docs: [backend-architecture.md](./backend-architecture.md),
> [db-design.md](./db-design.md), [provider-catalog.md](./provider-catalog.md),
> [9router-reference.md](./9router-reference.md). Progress tracking: [project-log.md](./project-log.md).
>
> **Working assumptions (veto anytime):** runtime = Node 22+ (builtin `node:sqlite`,
> builtin undici fetch). "Faster" = the measurable targets in §Goals. Estimates are in
> **work sessions** (one focused session ≈ 2-4h of build+verify); re-estimated after Phase 0.

## Goals (acceptance targets, measured not vibes)

| Target | Bar |
|---|---|
| Proxy overhead | ≤ 5ms p50, ≤ 15ms p99 added latency vs direct upstream call |
| TTFT delta | ≤ +10ms vs hitting the provider directly (same machine, warm pool) |
| Startup | < 500ms cold to ready |
| Memory | < 150MB RSS idle; **bounded** per-stream buffers (no full-response accumulation) |
| Stability | No global monkey-patching; single SQLite driver; crash of UI never affects proxy |
| Weight | Zero npm runtime dependencies (builtins only); single-file bundle < 5MB |

## Phase map

```
P0 Harness ──► P1 Core MVP ──► P2 Mgmt API + UI rewire ──► P3 Stability ──► P4 Speed ──► P5 Packaging
   (net)        (gateway)        (two-part real)             (hardening)     (faster)      (ship)
                                                    ╰──────── optional: P6 expansion ────────╯
```

| Phase | Deliverable | Sessions | Cumulative | Gate (must pass to advance) |
|---|---|---|---|---|
| P0 Harness | Golden translator tests + baseline harness | 2-3 | 3 | Golden tests pass against upstream behavior; baseline numbers recorded |
| P1 Core MVP | re-e-core serves `/v1/chat/completions` + `/v1/messages` via compatible node | 3-5 | 8 | Claude Code → RE-E → OpenRouter-node streaming session works end-to-end; no upstream diff at client |
| P2 Mgmt + UI | Management API + existing dashboard running against RE-E | 2-3 | 11 | Dashboard CRUD (nodes/keys/settings/usage) works out-of-process; UI crash doesn't touch proxy |
| P3 Stability | Hardened runtime | 2-4 | 15 | **DONE 2026-09-23** — gate passed: chaos pass (upstream killed mid-stream, restart mid-request, 20-way concurrent load) with no corruption, RSS delta 0MB on an 11.4MB stream, breaker state survived restart |
| P4 Speed | Optimized + observable | 2-3 | 18 | **DONE 2026-09-23** — overhead p50 15.6 → 1.3ms, p99 → 1.7ms (targets ≤5ms/≤15ms); metrics endpoint, latency-aware routing and budget caps shipped |
| P5 Packaging | Shippable artifact | 1-2 | 20 | **DONE 2026-09-23** — single-file ESM bundle (1.6MB / 798KB min, 216 modules, zero runtime deps) smokes 13/13 and passes both live rigs; multi-stage Dockerfile (unbuilt here — no docker); quickstart + configuration docs |
| P6 | Per-provider page | 2-4 | 24 | **DONE 2026-09-23** — gate passed: zero-model provider usable end to end (type an id → Test → it appears in /v1/models), import merges without deleting manual rows, a bad key blames only itself, probes leave usage/budget/breakers untouched, and `<prefix>/<unlisted>` still routes |

**Minimum viable product = P0+P1 (~8 sessions).** Everything after is quality or scope.

---

## P0 — Harness & baseline (do first, touches nothing)

Purpose: no refactor without a regression net; no "faster" claim without a baseline.

| # | Task | Notes |
|---|---|---|
| 0.1 | Golden SSE fixture corpus | Capture real streamed + non-streamed responses: openai↔claude, openai→openai (passthrough), claude→openai, incl. tool calls + thinking blocks. Source: run upstream 9Router locally with a compatible node; record client-facing bytes |
| 0.2 | Golden request-translation fixtures | Same for request side: same client body → upstream-bound bytes |
| 0.3 | Vitest project `tests/golden/` | Fixtures as input/expected pairs; tests import RE-E's translator (once it exists) and upstream's (now, to validate fixtures) |
| 0.4 | Baseline bench script | Script: N streaming requests through upstream 9Router → compatible node; record TTFT p50/p99, tokens/s, RSS, proxy-added latency (direct vs routed) |
| 0.5 | Record baseline numbers | Into project-log Knowledge Gained |

**Gate:** `npm test` green on fixtures validated against upstream; baseline table exists.

## P1 — Core MVP gateway

| # | Task | Port source |
|---|---|---|
| 1.1 | Repo skeleton `re-e-core/` | ESM, zero runtime deps, plain http server + tiny router (~100 LOC) |
| 1.2 | DB layer v1 | Per [db-design.md](./db-design.md): node:sqlite, WAL, repos, cache layer |
| 1.3 | Compatible nodes: routing + CRUD data model | `nodesRepo.js` shape; `{prefix}/{model}` → baseUrl |
| 1.4 | Default executor port | `executors/base.js` + `default.js` → undici Agent per node, stringify-once, keep retry/url-fallback design |
| 1.5 | SSE streaming pipeline | Rewrite of `utils/stream.js`: bounded buffers, incremental usage, multi-byte-safe decode, abort propagation |
| 1.6 | Translator port (openai↔claude only) | `open-sse/translator/**` as-is port; registry pattern kept; golden tests must stay green |
| 1.7 | RTK port | `open-sse/rtk/**` as-is (filters + autodetect) |
| 1.8 | `/v1/models`, `/v1/messages/count_tokens` | claude clients need them |
| 1.9 | API-key auth on `/v1` | hashed keys, `Authorization: Bearer` |
| 1.10 | Usage tracking | Batched writes per db-design; TTFT stamping |

**Gate:** P1 acceptance scenario above, on Windows, with tool calls + thinking + abort mid-stream.

## P2 — Management API + lean SPA wiring (redefined per ui-ux DECISIONS 2026-09-18)

Upstream-dashboard rewire is DEAD (user-ratified in ui-ux: OAuth reuse asset doesn't
exist in v1 scope; 100-route shim tax). v1 UI = the lean SPA `re-e-ui/` (Vite+React+TS+
Tailwind, Plex/Phosphor identity, merged from the ui-ux worktree with a verified mock-
transport preview). UI runs on mocks until wired — expected inconsistency is scoped here.

| # | Task |
|---|---|
| 2.1 | Session auth for `/api` (localhost token; bootstrap via CLI print) + same-origin `/ui/*` static serving from re-e-core |
| 2.2 | Management endpoints subset + ui-ux contract requests: settings, nodes CRUD (+`POST /nodes/{id}/test`), connections/api-keys CRUD, combos+aliases, proxy-pools (+`POST /proxy-pools/{id}/test`), usage (history/stats/details incl. ttftMs/durationMs), `GET /logs/stream` (SSE), breakers reset, health, version |
| 2.3 | Swap `re-e-ui` mock transport → real fetch client against the live API; build output served at `/ui/*` |
| 2.4 | `re-e init` CLI: create node, write key, configure one CLI tool's config file |

**Gate:** full loop from the SPA: create node (Test Connection green) → key → request flows → usage + live log visible.

## P3 — Stability pass

Circuit breakers (persisted cooldowns, half-open probing) · stream stall watchdog · error taxonomy (`upstream_error`/`auth_error`/`rate_limited`/`network_error`/`all_unavailable`) with SSE+JSON frames · graceful shutdown (drain streams) · config-as-file + env merge · log redaction (keys/tokens) · retention jobs (usage/details) · Windows service story (document + script).

## P4 — Speed pass

Undici pool tuning per node (keep-alive, connections, pipelining) · direct translator pairs to kill OpenAI pivot for openai↔claude (already direct in P1 — extend: claude→gemini-class if needed) · zero-copy passthrough as universal default when formats match · metrics endpoint (Prometheus text) · **latency-aware routing** (route to fastest healthy node using recorded TTFT) · **budget caps** (daily cost ceiling → auto-fallback to cheaper node).

## P5 — Packaging

esbuild → single-file ESM · Docker (multi-stage, distroless) · `re-e init` polish · optional Bun-compile binary experiment · docs: quickstart + config reference.

## P6 — Per-provider page (planned 2026-09-23)

Design + locked decisions: [provider-page.md](./provider-page.md). Backend first so
each half ships independently.

| # | Task |
|---|---|
| 6.1 | Backend: migration v2 (`node_models` + connection test columns), `node_models` repo, `data.models` boot backfill, `core/probe.mjs` (extracted shared probe), 8 endpoints — models CRUD, import (merge/stale), per-model test, per-key test, bulk key test |
| 6.2 | UI: nested `/upstreams/:id`, list rows become links, detail page with Models / API Keys / Settings tabs, drawer retired, UI renamed to "Providers" |
| 6.3 | Polish: bulk-test progress, stale surfacing, docs updates |

**Gate:** a provider with zero models is usable end to end (add an id by hand → test
→ it appears in `/v1/models`); import merges without deleting manual rows; a bad key
reports only its own error; probes leave usage, budget and breakers untouched;
`<prefix>/<unlisted-model>` still routes.

### P6 expansion menu (each independently schedulable)

First OAuth provider (pick from [provider-catalog.md](./provider-catalog.md) §5-7) ·
proxy-pool edge deployers · media module (TTS/STT/image/embeddings) · cloud sync.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Translator edge cases (tool calls, thinking, cache-control) break clients | P0 golden corpus before any port; fixtures captured from real upstream |
| node:sqlite behavioral gaps vs better-sqlite3 | Adapter seam kept thin; better-sqlite3 swap is one file if needed |
| Dashboard shim creep (mgmt API shape mismatch) | Port only the endpoints dashboard actually calls; log every shim |
| Scope creep via 122-provider catalog | Catalog is a menu, not a backlog; nothing enters a phase without a log entry |
| Windows-specific I/O issues (the upstream's EBUSY history) | Single driver + no native addons beyond node:sqlite removes the whole class |

## Working agreements

1. Upstream `9router/` stays frozen — reference only, never edited.
2. Every phase gate produces evidence (test output, bench table, screenshot of working flow) recorded in project-log before advancing.
3. New scope = new log decision entry first, code second.
