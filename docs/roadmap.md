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
| P3 Stability | Hardened runtime | 2-4 | 15 | Chaos pass: kill upstream mid-stream, restart core mid-request, concurrent load — no corruption, no unbounded memory, breaker state survives restart |
| P4 Speed | Optimized + observable | 2-3 | 18 | Targets table above met on the same baseline scenario |
| P5 Packaging | Shippable artifact | 1-2 | 20 | `npm run build` → single-file bundle + Docker image; `re-e init` configures a CLI tool without dashboard |
| P6 (optional) | Expansion | as needed | — | Per-item: first OAuth provider / lean SPA / media module |

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

## P2 — Management API + dashboard rewire

| # | Task |
|---|---|
| 2.1 | Session auth for `/api` (localhost token; bootstrap via CLI print) + CORS for UI origin |
| 2.2 | Management endpoints subset: settings, nodes CRUD, connections/api-keys CRUD, combos+aliases, usage (history/stats/details), health, version |
| 2.3 | Point existing 9Router dashboard at RE-E (config base URL; shim any endpoint-shape deltas) |
| 2.4 | `re-e init` CLI: create node, write key, configure one CLI tool's config file |

**Gate:** full loop from dashboard: create node → key → request flows; usage visible in dashboard.

## P3 — Stability pass

Circuit breakers (persisted cooldowns, half-open probing) · stream stall watchdog · error taxonomy (`upstream_error`/`auth_error`/`rate_limited`/`network_error`/`all_unavailable`) with SSE+JSON frames · graceful shutdown (drain streams) · config-as-file + env merge · log redaction (keys/tokens) · retention jobs (usage/details) · Windows service story (document + script).

## P4 — Speed pass

Undici pool tuning per node (keep-alive, connections, pipelining) · direct translator pairs to kill OpenAI pivot for openai↔claude (already direct in P1 — extend: claude→gemini-class if needed) · zero-copy passthrough as universal default when formats match · metrics endpoint (Prometheus text) · **latency-aware routing** (route to fastest healthy node using recorded TTFT) · **budget caps** (daily cost ceiling → auto-fallback to cheaper node).

## P5 — Packaging

esbuild → single-file ESM · Docker (multi-stage, distroless) · `re-e init` polish · optional Bun-compile binary experiment · docs: quickstart + config reference.

## P6 — Expansion menu (each independently schedulable)

First OAuth provider (pick from [provider-catalog.md](./provider-catalog.md) §5-7) · proxy-pool edge deployers · media module (TTS/STT/image/embeddings) · lean SPA dashboard (re-e-ui v2) · cloud sync.

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
