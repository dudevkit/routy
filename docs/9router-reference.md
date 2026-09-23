# 9Router — Master Reference

> **Status:** Canonical understanding document. Look this up at the start of any future
> conversation before re-exploring the code. Claims carry file anchors into
> `../9router/` so they can be verified or jumped to.
>
> **Snapshot date:** 2026-09-17, upstream `decolua/9router` @ v0.5.75 (fresh clone, `main`).
> Companion living document: the engineering journal kept in the development tree — read its
> "Current state" section after this one.

---

## 1. Brief (30-second version)

9Router is a **local AI gateway** (`npm i -g 9router`) that sits between CLI coding tools
(Claude Code, Codex, OpenClaw, Cursor, Cline, …) and 100+ AI providers. It exposes one
OpenAI-compatible endpoint (`http://localhost:20128/v1`), translates request/response
formats both ways, and adds: token compression (RTK), multi-provider/model/account
fallback, OAuth token refresh, quota tracking, and a web dashboard. The entire thing —
dashboard UI included — runs inside a single **Next.js 16** process.

**Why it matters to us:** the concept and the translation/fallback core are genuinely
good and battle-tested; the packaging (Next.js monolith, 4-driver SQLite fallback,
uncached reads) is what makes it heavy and fragile. Our project goal is a remake into a
**stable, lightweight, faster** gateway.

## 2. The numbers

| Metric | Value | Source |
|---|---|---|
| Core proxy code (`src/sse` + `open-sse`) | ~55k LOC | `wc -l` sweep |
| Dashboard pages (`src/app`) | 13.2k LOC | same |
| Persistence/lib (`src/lib`) | 15.2k LOC | same |
| Shared UI/components (`src/shared`) | 11.3k LOC | same |
| CLI package (`cli/`) | 6.6k LOC | same |
| Tests (`tests/`) | 36.9k LOC | same |
| Provider registry entries | 100+ files | `open-sse/providers/registry/` |
| Specialized executors | ~30 | `open-sse/executors/` |
| Wire formats | 13 | `open-sse/translator/formats.js:2-16` |
| SQLite driver fallbacks | 4 | `src/lib/db/driver.js:59-68` |
| Root package.json deps | 30 runtime (incl. monaco, recharts, sql.js, SAML, express) | `package.json:19-52` |

## 3. Repo map

```
9router/
├── custom-server.js        # Wraps Node http.createServer around Next standalone:
│                           #   per-process peer token, real-IP stamping, h2c upgrade
│                           #   compat, kicks background token refresh (lines 13-126)
├── next.config.mjs         # Rewrites /v1/* → /api/v1/* (Next serves the proxy!)
├── src/
│   ├── app/
│   │   ├── api/v1/*        # Compatibility APIs (the actual proxy endpoints)
│   │   ├── api/*           # ~100 management routes (auth, providers, oauth, keys,
│   │   │                   #   combos, usage, sync, cli-tools, tunnels, pxpipe, …)
│   │   ├── (dashboard)/    # React dashboard (providers, usage, token-saver, mitm, …)
│   │   ├── landing/        # Marketing landing page (shipped in the same app!)
│   │   └── login, callback
│   ├── sse/                # Request-entry layer (see §5)
│   │   ├── handlers/chat.js        # /v1/chat/completions + /v1/messages entry
│   │   ├── handlers/{embeddings,stt,tts,imageGeneration,search,videoGeneration,fetch}.js
│   │   └── services/       # auth (credential select), model resolution, token refresh,
│   │                       #   backgroundTokenRefresh, antigravityQuota
│   ├── lib/
│   │   ├── db/             # SQLite layer (schema, migrate, 4 adapters, repos)
│   │   ├── localDb.js      # Shim → re-exports db layer (legacy name kept)
│   │   ├── usageDb.js      # Shim → re-exports usage repos
│   │   ├── oauth/, tunnel/, mitm? (src/mitm/), pxpipe/, headroom/
│   │   └── appUpdater.js
│   ├── mitm/manager.js     # 883 LOC MITM proxy manager (e.g. Antigravity capture)
│   ├── shared/             # Dashboard components, constants (providers list), utils
│   ├── store/              # zustand stores (dashboard client state)
│   ├── dashboardGuard.js   # Dashboard auth guard (9.4k)
│   └── instrumentation.js  # Next instrumentation hook → app bootstrap
├── open-sse/               # ★ Framework-agnostic core (52k LOC) — see §4
│   ├── index.js            # Public exports; FIRST import patches globalThis.fetch
│   ├── handlers/           # chatCore.js (orchestrator), embeddings/tts/stt/image/video cores
│   ├── executors/          # base.js + ~30 provider executors (kiro 1302, cursor 1113, …)
│   ├── translator/         # formats + request/* + response/* + concerns/* + schema/*
│   ├── services/           # provider.js, model.js, combo.js, accountFallback.js,
│   │                       #   tokenRefresh/, oauthCredentialManager, capacityAdapter
│   ├── providers/          # registry/ (100+ provider defs), capabilities, pricing, models
│   ├── rtk/                # Token saver: filters/, autodetect, caveman, ponytail,
│   │                       #   headroom, pxpipe bridges
│   └── utils/              # stream.js (SSE transform), proxyFetch.js, clientDetector,
│                           #   usageTracking, requestLogger, cursorProtobuf, …
├── cli/                    # npm package "9router": cli.js launcher (29.8k), systray hooks,
│                           #   esbuild build; sqlite deps installed to ~/.9router/runtime
├── tests/                  # vitest; only /v1/embeddings core + cloud worker covered (59 tests)
├── skills/                 # Agent skills (9router-chat, web-fetch/search, tts, stt, …)
├── docs/ARCHITECTURE.md    # Upstream architecture doc (557 LOC, good but aspirational)
├── gitbook/, i18n/, images/, public/
└── Dockerfile, docker-compose.yml, start.sh, captain-definition
```

## 4. Process & packaging model (critical to understand)

1. **One Node process runs everything.** `custom-server.js` monkey-patches
   `http.createServer`, starts Next standalone, and lazily imports
   `src/sse/services/backgroundTokenRefresh.js` (custom-server.js:18-47,76-78).
2. **The proxy is Next API routes.** `next.config.mjs` rewrites `/v1/*` → `/api/v1/*`.
   Every inference request flows through Next's router + middleware machinery.
3. **First import of `open-sse/index.js` patches `globalThis.fetch`** with
   `proxyAwareFetch` (proxyFetch.js:364-366) — env-proxy support, DNS-bypass for MITM,
   Google-DNS real-IP resolution. Affects *every* fetch in the process, dashboard included.
4. **Distribution:** `cli/` package (global npm install) downloads/launches the app from
   `~/.9router/`; SQLite native deps are installed into `~/.9router/runtime/node_modules`
   at postinstall to dodge Windows EBUSY (cli/package.json:31-32). Docker image also shipped.
5. **Ports:** production default **20128**; repo dev script uses 20127
   (package.json:7). `DATA_DIR` env overrides data dir; default `~/.9router/`.

## 5. Request lifecycle — `/v1/chat/completions` (verbose)

Numbered steps with anchors. This is the hot path; every listed call happens per request.

**Entry — Next route → `src/sse/handlers/chat.js`**
1. `request.json()` parse (chat.js:34-40).
2. `stripModelContextMarker` — Claude Code sends `<model>[1m]` suffix; split it off, keep
   capability in `anthropic-beta` header (chat.js:51-55).
3. API key extraction + optional `requireApiKey` enforcement; **`getSettings()` DB read
   #1** (chat.js:60-81).
4. `handleBypassRequest` — intercepts warmup/naming probes before burning rotation slots
   (chat.js:88-91).
5. `detectRequiredCapabilities(body)` — does the request need vision/tools/etc.
6. `getComboModels(modelStr)` — **DB read #2** if the model string is a combo name
   (chat.js:96). Combos route through `handleComboChat` / `handleFusionChat`.
7. Single model → `handleSingleModelChat` (chat.js:166):
   - `getModelInfo(modelStr)` — parses `provider/model` or alias; alias maps are built
     once at module load from the registry (in-memory, cheap) — `open-sse/services/model.js:13-18`.
   - Account loop (chat.js:233-338): `getProviderCredentials` (**DB read**, per attempt)
     → `checkAndRefreshToken` → for antigravity/gemini-cli, lazily resolve + persist
     projectId (chat.js:256-263) → **`getSettings()` DB read #3** (chat.js:266) →
     `handleChatCore(...)`.

**Core — `open-sse/handlers/chatCore.js:61` (`handleChatCore`)**
8. Source format detection: endpoint path first (`/v1/messages` → claude, `/v1/responses`
   → openai-responses), then body shape (formats.js:22-35).
9. Target format resolution with a nice optimization: **transport matching** — if the
   provider offers an endpoint that speaks the client's format natively, use it and skip
   translation entirely (`resolveTransport`, chatCore.js:87-99).
10. Streaming decision matrix: provider `forceStream`, image-gen models forced
    non-streaming, deepseek-tui quirks, Accept-header sniffing for AI SDK compat
    (chatCore.js:118-142).
11. **Native passthrough check** — when client ecosystem == provider ecosystem (claude→
    claude providers), skip all translation; only model id + auth swapped
    (chatCore.js:149-152,173-189). This is the zero-overhead path.
12. If translating: `translateRequest(source→target)` — request side has **direct pair
    translators** (e.g. claude-to-kiro) registered at module load; pipeline: strip
    unsupported content types, tool-call id repair, thinking unification, tool cloaking,
    schema translation (translator/index.js:52-159).
13. Modality strip (media the model can't read) + **`prefetchRemoteImages` — awaited
    inline before dispatch** (chatCore.js:158-168). Latency hazard.
14. Tool dedupe for Claude clients (chatCore.js:204-211).
15. Token savers applied to final body: RTK `compressMessages` (regex filters on
    tool_result text — git diff/log/status, grep, ls, tree, dedup-log, smart-truncate;
    sizes gated by `MIN_COMPRESS_SIZE`/`RAW_CAP`, never grows input; rtk/index.js:8-146),
    plus optional headroom (external HTTP service, default localhost:8787), pxpipe
    (lazy-installed local module), caveman/ponytail (system-prompt injectors).
16. Executor dispatch (`open-sse/executors/base.js:100-184`): per-URL fallback loop with
    per-status retry config, connect-timeout AbortController (`AbortSignal.any` merge),
    `JSON.stringify(transformedBody)` **recomputed per attempt**, `proxyAwareFetch`.
17. 401/403 → executor `refreshCredentials()` → retry with merged tokens
    (oauthCredentialManager + tokenRefresh per-provider functions).

**Response — `open-sse/handlers/chatCore/streamingHandler.js` + `open-sse/utils/stream.js`**
18. Non-streaming: buffer whole upstream response, translate once (nonStreamingHandler).
19. Streaming: `TransformStream` (stream.js:39-489) — per-chunk: TextDecoder(stream:true,
    multi-byte safe) → SSE line parse → `translateResponse(target→source)`. Response side
    uses **direct pair translator if registered, else OpenAI pivot (two hops)**
    (translator/index.js:179-211). Per stream it accumulates `accumulatedContent` +
    `accumulatedThinking` in full (stream.js:67-68) for usage logs — unbounded memory.
20. Usage extraction (exact when upstream reports, estimated otherwise), TTFT stamping,
    then `saveRequestDetail` / usage SQLite writes (sync driver → event-loop block).
21. Failures feed back into the account loop: `markAccountUnavailable` (cooldown in RAM),
    antigravity quota special-case (chat.js:312-335), next account or next combo model.

**Fallback hierarchy (the product's core value):** combo models → provider accounts
(round-robin/sticky) → base-url fallbacks per executor → per-status retries. Cooldowns
live in RAM (`accountFallback.js`), survive only in-process.

## 6. Wire formats & translation system

`FORMATS` (formats.js:2-16): openai, openai-responses, openai-response, claude, gemini,
gemini-cli, vertex, codex, antigravity, kiro, cursor, ollama, commandcode.

- **Registry pattern:** translators self-register via side-effect imports
  (translator/index.js:281-302); request side maps source→target, response side
  target→source. Direct pairs where they exist; OpenAI as pivot otherwise.
- **Concerns** are shared transform layers: chunk, finishReason, image, json, message,
  modality, paramSupport, prefetch, reasoning, thinking(+Unified), toolCall, usage.
- **Provider-side quirks get real modules:** Cursor uses protobuf (utils/cursorProtobuf.js
  904 LOC) + checksum (cursorChecksum.js); Kiro has its own conversation shape +
  conversationState; Antigravity is Gemini-family with quota semantics; Codex speaks the
  Responses API.
- **Client detection** (`utils/clientDetector.js`) keys off user-agent/body shape →
  enables passthrough and client-specific fixes.

## 7. Provider / credential system

- `open-sse/providers/registry/*.js` — one file per provider: transport, baseUrls,
  formats, auth type, models, pricing hints. Template: REGISTRY_TEMPLATE.js.
- `open-sse/executors/*` — `BaseExecutor` (fetch/retry/fallback) + specialized overrides
  (~30): kiro (1302 LOC), cursor (1113), devin-cli (847), qoder (704), antigravity (652),
  windsurf (588), codex, gemini-cli, github copilot, ollama-local, vertex, …
- **OAuth:** `/api/oauth/[provider]/[action]` routes + per-provider refresh functions
  (tokenRefresh/providers.js 707 LOC). Background refresher runs on a schedule
  (src/sse/services/backgroundTokenRefresh.js). Refresh dedup exists
  (services/tokenRefresh/dedup.js) — concurrent 401s don't stampede.
- **Account fallback:** provider connections = accounts; cooldown via
  `markAccountUnavailable` (status-code + error-message heuristics), sticky round-robin,
  per-model locks for antigravity reset windows.
- **Quota tracking:** `open-sse/services/usage/*` per provider (claude, codex, glm, kimi,
  github, groq, …) ping provider usage endpoints; surfaced in dashboard "Quota" page.

## 8. Persistence (current state)

- `src/lib/db/` — SQLite with repos (settings, connections, nodes, apiKeys, combos,
  pricing, usage 772 LOC, requestDetails). Schema + versioned migration (migrate.js 297).
- **Driver chain** (driver.js:59-68): Bun→`bun:sqlite`; Node→`better-sqlite3` (skipped on
  Node ≥24 due to SIGSEGV) → `node:sqlite` (≥22.5) → `sql.js` WASM. Adapter singleton on
  `global._dbAdapter` to survive Next dev hot-reload (driver.js:4-5).
- Usage: `usage` + `request_details` tables + request-detail JSON blobs; pending-request
  tracker in memory (`trackPendingRequest`).
- **No caching layer anywhere in repos** — every `getSettings()`/credential read is a
  fresh SQLite query (verified: no cache/ttl/memo in repos), and settings are read 2–3×
  per chat request (chat.js:70, 173/266).
- Cloud sync (optional): push/pull provider+alias+combo state to `NEXT_PUBLIC_CLOUD_URL`
  keyed by machineId (ARCHITECTURE.md §5).

## 9. Full API surface

**Proxy (compat):** `/v1/chat/completions`, `/v1/messages` (+`/count_tokens`),
`/v1/responses` (+`/compact`), `/v1/models`, `/v1/embeddings`, `/v1/audio/{speech,
transcriptions,voices}`, `/v1/images/generations`, `/v1/videos/*`, `/v1/web/fetch`,
`/v1/search`, `/v1beta/models` (Gemini-style), `/v1/api/chat`.
**Management (~100 routes):** auth (login/oidc/saml), settings, providers (+validate/
test), provider-nodes, oauth, keys, models (alias/custom/availability), combos, pricing,
usage (history/stats/chart/logs/details/stream), proxy-pools (incl. cloudflare/deno/
vercel deploy), pxpipe, headroom, mitm, tunnels (cloudflare/tailscale), cli-tools
(per-CLI settings writers for ~15 tools), sync/cloud, version/updater/shutdown.

## 10. Token savers (the "RTK" family)

| Saver | Mechanism | Where |
|---|---|---|
| RTK | Regex filters rewrite tool_result text (git diff/log/status, grep, ls, tree, find, readNumbered, searchList, buildOutput, dedupLog, smartTruncate); autodetect picks filter; never grows/empties | open-sse/rtk/ |
| Headroom | External compression microservice (default localhost:8787), optional user-message compression | rtk/headroom.js |
| Pxpipe | Local module (lazy-installed), min-chars threshold (25k), timeout-guarded | rtk/pxpipe.js, src/lib/pxpipe/ |
| Caveman / Ponytail | System-prompt injectors (prompt-based verbosity control) | rtk/caveman*.js, rtk/ponytail*.js |

Default: **RTK on** (settingsRepo.js:52); others off. Claimed savings 20–40%/request.

## 11. Dashboard & peripheral subsystems (weight, not hot path)

React 19 + Tailwind 4 + zustand + monaco-editor + recharts + dnd-kit + material-symbols;
i18n runtime ×10 languages (src/i18n + public/i18n); landing page; SSO (OIDC/SAML via
@node-saml/node-saml + jose + bcryptjs); MITM manager; tailscale/cloudflare tunnel
managers (src/lib/tunnel/tailscale 859 LOC); proxy pools with edge deployers; app
updater; system tray via CLI (PowerShell NotifyIcon on Windows); skills/ folder ships
agent skills for OpenClaw-style consumers; gitbook/ is a separate docs site build.

## 12. Tests (state of the world)

Only `/v1/embeddings` core + a cloud worker handler are unit-tested (59 tests,
tests/README.md). Zero coverage on: chat hot path, translators, fallback, executors,
token refresh. `scripts/test-combo-autoswitch.mjs` is a manual harness. **Any remake
must front-load golden tests for translators before touching code.**

## 13. Findings — what hurts stability / weight / speed (evidence table)

### Stability
| # | Finding | Anchor |
|---|---|---|
| S1 | `globalThis.fetch` monkey-patched on first core import — process-wide behavior change, order-dependent, affects dashboard+updaters | proxyFetch.js:364-366; open-sse/index.js:2 |
| S2 | 4-driver SQLite chain → machine-dependent behavior; sql.js fallback = WASM in-memory DB (durability+perf cliff) | driver.js:59-68 |
| S3 | Full-response accumulation per stream (content + thinking) — unbounded memory on long outputs | stream.js:66-68 |
| S4 | Settings re-read + refresh check inside account retry loop — I/O and state churn mid-retry | chat.js:233-266 |
| S5 | Global mutable singletons (`global._dbAdapter`, combo rotation Map, RAM cooldowns) — dev-reload + multi-process hazards | driver.js:4-5, combo.js:88, accountFallback |
| S6 | custom-server wraps `http.createServer` globally + patches `server.emit` — fragile with runtime upgrades | custom-server.js:52-124 |

### Weight
| # | Finding | Anchor |
|---|---|---|
| W1 | Latency-critical proxy runs inside Next.js (rewrites + guard + React runtime in-process) | next.config.mjs; package.json |
| W2 | ~60% of core LOC is long-tail providers (cursor protobuf 904, kiro 1302, devin 847…) | open-sse LOC sweep |
| W3 | Dashboard deps (monaco, recharts, sql.js, SAML, express, http-proxy-middleware) ride along | package.json:19-52 |
| W4 | i18n ×10 + landing page + gitbook shipped in same repo/app | i18n/, gitbook/ |

### Speed
| # | Finding | Anchor |
|---|---|---|
| F1 | `getSettings()` = fresh SQLite read ×2–3 per request, no cache | chat.js:70,266; settingsRepo.js:92-95 |
| F2 | Credential select + refresh check per attempt = DB reads in retry loop | chat.js:234-253 |
| F3 | better-sqlite3 sync driver → usage/detail writes block event loop mid-stream | usageRepo.js; driver.js:19-33 |
| F4 | `prefetchRemoteImages` awaited inline before first byte | chatCore.js:163-168 |
| F5 | Body re-stringified per retry attempt; headers rebuilt per attempt | base.js:128-149 |
| F6 | Response chunks pivot through OpenAI when no direct pair registered | translator/index.js:185-211 |
| F7 | No tuned connection pooling (plain fetch; undici default agent) | base.js:144-149 |
| F8 | Per-request raw-body logging (reqLogger.logRawRequest) — allocation + I/O | chatCore.js:144-146 |

### Things done RIGHT (keep in the remake)
- Transport matching (native-format endpoint → zero translation) — chatCore.js:87-99
- Native passthrough for same-ecosystem client+provider — chatCore.js:149-189
- Multi-byte-safe stream decoding; connect-timeout AbortController; Retry-After-aware
  dynamic retry hook — stream.js:60; base.js:134-138,116-120
- Token-refresh dedup; never-grow/never-empty RTK guarantees; capability-adapter
  auto-augmentation for missing model features (vision etc.)

## 14. Glossary

- **RTK** — the tool_result compression filter set (default-on token saver)
- **Combo** — ordered model list with fallback / round-robin (sticky) / fusion strategies
- **Fusion** — fan out to N models, judge model picks best answer (combo.js)
- **Capacity adapter** — auto-substitute a model that supports a capability the target
  lacks (e.g. vision) — capacityAdapter.js
- **Passthrough** — same-ecosystem client→provider: no translation, model+auth only
- **Transport** — provider endpoint that natively speaks a given wire format
- **Connection / account** — one credential set for a provider; many per provider allowed
- **TTFT** — time to first token (measured per request, ttftAt in stream.js)
- **Headroom / pxpipe / caveman / ponytail** — auxiliary token savers (§10)
- **cli-tools** — dashboard writers that edit each CLI tool's own config files to point
  them at 9Router

## 15. Verbatim truths worth remembering

1. Upstream calls itself `9router-app` (private) — only `cli/` publishes as npm `9router`.
2. README markets "FREE AI Router & Token Saver… auto-fallback to FREE & cheap models" —
   free-tier providers (Kiro, OpenCode Free, Vertex credits) are first-class product features.
3. The dashboard *writes other tools' config files* (claude/codex/cursor settings) —
   cli-tools API is an onboarding convenience we should keep conceptually.
4. Node ≥24 deliberately skips better-sqlite3 (SIGSEGV guard) — driver.js:22-25.
5. Docs claim "shared SSE/routing core" portability ("shared between SSE and Worker",
   chatCore.js:35) — the Cloudflare-worker variant exists in `cloud/` for embeddings only.
