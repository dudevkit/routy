# RE-E Backend Architecture

> Target design for `re-e-core/`. Port mapping from upstream 9Router v0.5.75.
> Frozen reference: `../9router/`. DB details: [db-design.md](./db-design.md).
> Provider roadmap: [provider-catalog.md](./provider-catalog.md).

## 1. Process model

One Node ≥22 process. Two route trees on one HTTP server:

```
re-e-core (Node 22+, zero runtime deps)
├── /v1/*      → proxy router    (client CLI tools; API-key auth)
└── /api/*     → management router (dashboard/CLI; session or bootstrap-token auth)
```

- No Next.js, no Express/Fastify on the hot path. Hand-rolled router (~100 LOC):
  exact-match map + method, param patterns for `/api/*`, streaming-native (`Request`/`Response`
  web APIs or raw req/res — decision: raw Node req/res, no web-virtual wrappers).
- UI is a separate process (P2 wires the existing dashboard; SPA later).
- Long-lived singletons only for: SQLite handle, settings cache, breaker state, undici
  dispatchers. **No `globalThis.fetch` patching ever** — proxy uses explicit `undici`
  `Agent`/`ProxyAgent` instances per node.

## 2. Module map (port map)

```
re-e-core/
├── server.mjs               # bootstrap: config load → db open → http server → ready
├── lib/
│   ├── router.mjs           # tiny router (write new)
│   ├── config.mjs           # file + env merge (write new; 12-factor)
│   ├── auth.mjs             # api-key hash/verify, session tokens (write new)
│   └── log.mjs              # structured, redacted, async-flushed (write new)
├── db/                      # per db-design.md (port + rewrite of src/lib/db/**)
│   ├── driver.mjs           # node:sqlite only, WAL (replaces 4-driver chain)
│   ├── cache.mjs            # settings/nodes/connections cache + invalidation (NEW)
│   └── repos/               # nodes, connections, keys, combos, aliases, settings,
│                            #   usage, requestDetails, proxyPools, breakers
├── core/
│   ├── handlers/chat.mjs    # slimmed chatCore (port of open-sse/handlers/chatCore.js
│   │                        #   minus headroom/caveman/ponytail/pxpipe; RTK stays)
│   ├── executors/
│   │   ├── base.mjs         # port of executors/base.js — retry, url fallback,
│   │   │                    #   connect-timeout AbortController (keep design)
│   │   └── default.mjs      # port of default executor + undici Agent per node
│   ├── translate/           # AS-IS port of open-sse/translator/** (P1: openai↔claude)
│   ├── rtk/                 # AS-IS port of open-sse/rtk/** (filters, autodetect)
│   ├── routing/
│   │   ├── model.mjs        # port of services/model.js (parse prefix/model, aliases)
│   │   ├── combo.mjs        # port of services/combo.js (fallback + round-robin;
│   │   │                    #   fusion deferred)
│   │   ├── fallback.mjs     # port of accountFallback.js + NEW persisted breakers
│   │   └── latency.mjs      # NEW (P4): fastest-healthy-node selection
│   ├── usage.mjs            # port of usageTracking.js, incremental (stream-side)
│   └── sse/stream.mjs       # REWRITE of utils/stream.js — see §4
├── http/
│   ├── v1.js                # /v1 routes (thin; port of src/sse/handlers/chat.js entry)
│   └── api.js               # /api management routes (write new, lean)
└── bin/re-e.mjs             # CLI: init wizard, run, token print
```

**Porting rules:** translate/ and rtk/ arrive as verbatim ports (golden-tested, §P0).
Executor base arrives with design intact but bodies modernized (stringify-once, agent
reuse). Stream pipeline is a rewrite — upstream's is the spec, not the code (unbounded
accumulation, per-chunk string concat). Everything dashboard-only stays behind.

## 3. Request lifecycle (target)

```
CLI ──POST /v1/chat/completions──► router ──► auth (api key, hashed lookup)
  │
  ├─ parse body (single JSON.parse; reuse for logging tail, not per-chunk)
  ├─ routing: strip [1m]-markers → alias/combos resolve → node select
  │    (healthy filter: breakers + budget caps → latency-aware pick [P4])
  ├─ token savers: RTK compressMessages on tool_result text (in-place, gated)
  ├─ translate request (passthrough if node format == client format)
  ├─ executor: buildUrl/headers once → undici Agent(node).fetch
  │    ├─ connect timeout (AbortSignal.any) → retry per status config → url fallback
  │    └─ 401/403 → auth error taxonomy (OAuth refresh lands here in P6)
  ├─ response: stream SSE through transform (see §4) → client
  └─ tail: usage event + request detail (batched, off hot path) → breaker update
```

Failure path: executor/network/status errors → breaker trip (node cooldown, persisted)
→ retry next node or next combo model → taxonomy error frame to client with Retry-After
when upstream supplied one.

## 4. SSE pipeline (the one deliberate rewrite)

Upstream spec kept: line-based parse, multi-byte-safe `TextDecoder({stream:true})`,
translate-per-chunk via registry, usage extraction, TTFT stamp. Changes:

| Upstream behavior | RE-E behavior |
|---|---|
| `accumulatedContent`/`accumulatedThinking` grow unbounded | Counters + rolling hash for dedup/log; hard cap (default 2MB) on any retained text; overflow truncates log only |
| Per-chunk string concat + re-emit | Byte-buffer chunks, single `formatSSE` emit per event |
| Usage estimated post-hoc from accumulated text | Incremental token estimation during stream; exact when upstream reports |
| Disconnect handling via wrapped `server.emit` | Native `req.on('close')` → `AbortController` → upstream fetch abort |
| Usage writes sync mid-stream | Batched queue, flushed on timer/size (db-design §4) |

## 5. API surface v1

**Proxy (`/v1`, Bearer api-key):**
`POST /chat/completions` · `POST /messages` · `POST /messages/count_tokens` ·
`GET /models` (+`GET /models/{id}`) · `POST /embeddings` (node-passthrough) ·
`GET /health` (no auth).

**Management (`/api`, session token):**
`GET/PUT /settings` · CRUD `/nodes`, `/connections`, `/keys`, `/combos`, `/aliases`,
`/proxy-pools` · `GET /usage/{stats,history,details}` · `POST /breakers/{id}/reset` ·
`GET /health`, `GET /version`. Deliberately NOT ported: oauth/*, cli-tools/* (→ `re-e init`
covers the 90% case), mitm/*, tunnels/*, sync/*, updater/*.

**Folded from ui-ux contract-requests.md (2026-09-18, P2 scope):**
`POST /nodes/{id}/test` → `{ok, latencyMs, models?}` (probe node baseUrl + `/models`
listing) · `POST /proxy-pools/{id}/test` → `{ok, latencyMs, error?}` ·
`GET /logs/stream` (SSE: `init` ring-buffer snapshot, `line`, `clear`; optional `?level=`)
· usage `details` rows carry `ttftMs`, `durationMs`, token counts, `nodeId`, `errorCode`
(schema v1 already captures all of these — confirmation, not new work).

**UI delivery (P2 redefined per ui-ux DECISIONS):** the lean SPA (`re-e-ui/`, Vite +
React + TS + Tailwind, Plex/Phosphor identity) replaces the "rewire upstream dashboard"
plan — upstream reuse is dead (OAuth asset out of v1 scope; 100-route shim tax). SPA is
served by re-e-core at `/ui/*` (static `dist/`); its `src/api/mock.ts` transport swaps to
real fetch against these endpoints. Known inconsistency until wired: UI runs on mocks.

## 6. Config & state

- `~/.re-e/` data dir (override `RE_E_HOME`): `re-e.db` (SQLite WAL), `config.json`,
  `logs/`.
- Precedence: defaults < `config.json` < env (`RE_E_PORT`, `RE_E_HOME`, `RE_E_LOG_LEVEL`, …)
  < settings table (dashboard-writable runtime settings).
- Secrets (node API keys): SQLite `connections.credentials` — plaintext v1 (upstream
  parity), DPAPI/keychain wrapper behind one interface, P3 hardening.

## 7. Error taxonomy

| code | meaning | client surface |
|---|---|---|
| `auth_error` | client key invalid / upstream 401-403 after refresh path | 401/403 JSON; SSE terminal frame |
| `rate_limited` | upstream 429 | 429 + Retry-After passthrough |
| `upstream_error` | 5xx / malformed upstream | 502 JSON; SSE terminal frame |
| `network_error` | connect/timeout/DNS | 502 after retries |
| `all_unavailable` | breakers open everywhere | 503 + human retry hint |

Combo/fallback continues on every class except client-side `auth_error`.

## 8. Testing & conventions

- **Vitest** (dev-only dep) + golden fixtures (`tests/golden/`, P0). Unit tests for
  routing/fallback/breakers; integration test spins the real server against a stub node.
- ESM only. No top-level side effects outside `server.mjs`/`bin/`. No `globalThis` writes.
  `crypto.randomUUID()` over uuid pkg. Node 22+ APIs assumed (builtin fetch, `node:sqlite`).
- Formatter/linter: pick once in P1 (eslint flat + prettier) — decision deferred to
  first commit, then never re-litigated.
- Perf budget per PR: no new runtime dep; hot-path allocations reviewed; streaming path
  never buffers whole responses.
