# Upstream Dashboard Inventory (RE-E ui-ux — brainstorm step 1)

> Source recon of 9Router v0.5.75 dashboard, 2026-09-17. Method: direct source read of
> `9router/src/app/(dashboard)/` + `9router/src/shared/components/` + `package.json`.
> No screenshots (upstream app not installed here); line counts are from source.

## Nav model (Sidebar.js)

- **Main:** Endpoint & Key (home) · Providers · Combo & Vision Adapter · Usage ·
  Quota Tracker · Token Saver · CLI Tools
- **System:** Media Providers (accordion: embedding/image/video/tts/stt + Web Fetch & Search) ·
  Proxy Pools · Skills
- **Debug:** Console Log · Translator (flag-gated via `settings.enableTranslator`)
- Chrome: mac traffic-lights decoration, vibrancy/blur sidebar, material-symbols icons,
  updater banner (copy install cmd → countdown → server shutdown), NineRemote promo modal.

## Per-page inventory → keep/cut

| Route / component | LOC | What it does | Verdict | Notes |
|---|---|---|---|---|
| `/dashboard` (home) → `EndpointPageClient` | 1305 | Endpoint URL + API key display, machine ID, status polling/ping, security warning, tunnel UI | **Keep, trimmed** | The "connect in 60s" anchor. Drop tunnel/remote bits; merge `/endpoint` duplicate into it |
| `/providers` | 1027 | Provider cards (OAuth vs API-key vs compatible), status filter + header search, `AddCompatibleModal` (custom baseUrl+key+prefix node), test results view, per-card toggles | **Keep — core** | Compatible-node add is exactly RE-E's node mechanism |
| `/providers/new` | 219 | Thin form: provider, auth method, key | **Merge** into providers page as modal | |
| `/providers/[id]` | 1906 | Detail: model rows, passthrough/compatible model sections, connections, 6 OAuth modals (Kiro/Cursor/Xiaomi/IFlow/GitLab/Generic), bulk import (Codex/Grok CLI), auto-ping settings | **Keep, heavily trimmed** | Core = compatible-node editor + connections + model list. OAuth/bulk-import bulk is upstream-provider baggage |
| `/combos` | 855 | Combo builder: dnd-kit drag-drop model ordering, strategies, **capacity adapter** (vision/audio fallback pools), model select modal, validation | **Keep — core** | Drag-and-drop builder is explicitly worth stealing (brief) |
| `/usage` | 75 | Tabs: Overview (`UsageStats`) / Details (`RequestDetailsTab`) / Logs (`RequestLogger`); periods today→60d | **Keep — core** | |
| `UsageStats` | 533 | Group-by tables (model/account/api-key/endpoint), recent requests, time-ago, lazy topology, chart | **Keep — core** | |
| `UsageChart` | 141 | recharts AreaChart, tokens/cost toggle | **Keep** | recharts is the one chart dep worth carrying (or swap for a tiny sparkline lib) |
| `ProviderTopology` | 487 | @xyflow/react radial topology, "electric kame beam" animated active edges, particles, per-provider icons | **Cut v1** | Eye candy; heavy dep. v2 candidate as a lighter "status board" |
| `RequestDetailsTab` | 510 | Paginated request drill-down, collapsible sections, token breakdown incl. cache read/creation | **Keep — core** | This is the "find a slow request in <3 clicks" surface |
| `RequestLogger` | 121 | Request log table, 3s polling toggle | **Keep** | Switch polling → backend SSE (brief requirement) |
| `/quota` → `ProviderLimits` | 1549 | Per-connection quota bars, pagination, auto-refresh, hidden-row prefs, Kiro/Codex-specific handling | **Keep-idea, trimmed** | Progress-bar pattern worth stealing; only what backend v1 usage API supports |
| `/token-saver` | 1036 | RTK config: wenyan locales, caveman/ponytail levels, preview | **Keep** | §B scope (RTK keep; headroom/caveman/ponytail throw) |
| `/console-log` | 96 | SSE stream (`init`/`line`/`lines`/`clear` events), level coloring, max-lines ring buffer, clear button | **Keep — core** | Simplest good implementation in the codebase; matches RE-E SSE seam |
| `/cli-tools` + `[toolId]` | 66+11+cards | One-click config writers per CLI tool, status per tool, MITM tools section | **Fold into `re-e init`** | Keep as read-only "Setup" page if UI exists; `cli-tools/*` API deliberately not ported |
| `/proxy-pools` | 1063 | Pool CRUD + test, batch import, health-check (concurrency 10, progress), bulk ops, strict-proxy/noProxy, **relay deploy modals: Vercel/Cloudflare/Deno** | **Keep (user requirement)** | Relay-deploy modals are an open scope question (see DECISIONS) |
| `/media-providers/*` (4 pages) | ~1000 | Embeddings/image/tts/webSearch/webFetch providers, combos, per-kind curl examples, custom embedding nodes | **Cut** | Backend v1 defers media (§C) |
| `/mitm` | thin | MITM capture tooling | **Cut** | Backend de-scoped mitm/* |
| `/pxpipe` | thin | pxpipe integration | **Cut** | Deferred per locked scope |
| `/skills` | 112 | Static agent-skill URL list with copy buttons | **Cut** | Peripheral |
| `/translator` | 303 | 7-step translator debugger (client req → … → client res) with monaco, step-through: toOpenAI → toTarget → send | **Cut v1, v2 candidate** | Genuinely useful power-debug tool; depends on backend step logging we didn't spec; monaco dep |
| `/basic-chat` | thin | Minimal chat playground | **Cut** | Test via curl/CLI |
| `/profile` | 1702 | Settings hub: theme, language, shutdown, fallback + combo strategy, sticky limit, password change, DB export/import w/ auth, **OIDC + SAML SSO**, outbound proxy + test, remote-host awareness | **Keep, heavily trimmed** | RE-E Settings: theme, strategies, shutdown, config export, maybe outbound proxy. Cut SSO/password/DB-auth (local single-user dev tool) |

## Shared component vocabulary (`shared/components`, 46 files)

- **Reusable core (~20):** Card, Button, Input, Select, Toggle, Modal (+ConfirmModal),
  Drawer, Badge, Tooltip, SegmentedControl, Pagination, Loading/CardSkeleton,
  ProviderIcon, UsageStats, RequestLogger, Avatar, ThemeProvider/Toggle.
- **Baggage (~26):** 10+ OAuth-flow modals, SSO bits, Donate/Pricing/Changelog/
  McpMarketplace/NineRemote promo modals, LanguageSwitcher, NoAuthProxyCard, etc.
- **Styling system:** Tailwind + CSS custom props (`text-text-main`, `bg-surface-2`,
  `border-border-subtle`, `--shadow-soft`), material-symbols icons, `rounded-[14px]`
  cards, backdrop-blur "vibrancy", dark-first via ThemeProvider, zustand stores
  (notifications, header search).

## Dependency weight (why the split was right)

`recharts` · `monaco-editor` + `@monaco-editor/react` · `@dnd-kit/*` ×4 ·
`@xyflow/react` · `@node-saml/node-saml` · `jose`/`bcryptjs`/`node-forge` (SSO/auth) ·
`sql.js` · `express` + `http-proxy-middleware` (server embedded in UI process!) ·
material-symbols · i18n ×10 locales · zustand.

## Worth stealing (patterns, not code)

1. Combo drag-and-drop builder (dnd-kit, keyboard sensor included)
2. Quota progress bars + auto-refresh rhythm
3. Console log SSE protocol (`init`/`line`/`lines`/`clear` + level colors + ring buffer)
4. Per-request drill-down with collapsible sections + token breakdowns (incl. cache)
5. Status filter + global header search on provider list
6. Copy-cmd-then-shutdown update flow (fits `re-e` single-binary story later)

## Open questions carried to DECISIONS.md

1. Proxy-pools relay deploy (Vercel/Cloudflare/Deno modals) — keep, cut, or defer?
2. ProviderTopology — cut v1 confirmed? (recommend cut)
3. Translator step debugger — v2 candidate or dead?
4. Quota page — fold into Usage as a tab vs standalone nav item?
