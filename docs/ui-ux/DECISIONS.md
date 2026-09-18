# RE-E UI/UX Decisions (append-only, dated)

> Format: `## YYYY-MM-DD — Title` then decision, rationale, alternatives rejected.
> Settled = user-ratified or derived from already-locked project decisions.
> Tentative = assistant recommendation awaiting user ratification.

---

## 2026-09-17 — Process: designer role for preview builds (user instruction)

When building UI/UX code for preview — even throwaway preview builds — work design-first
(IA → tokens → component vocabulary → screens); visual/interaction quality is the
deliverable, not engineer-default scaffolding. (Also recorded in brainstorm-brief.md.)

## 2026-09-17 — Inventory doc created (settled)

`upstream-dashboard-inventory.md` — per-page keep/cut table, component vocabulary,
dependency weight, steal-list. Evidence base for IA proposal + reuse/rebuild verdict.

## 2026-09-17 — Cut list follows locked backend scope (settled)

Cut: `/media-providers/*` (4 pages), `/mitm`, `/pxpipe`, `/skills`, `/basic-chat`,
ProviderTopology (v1), OAuth bulk of `/providers/[id]`, SSO/password/DB-auth bulk of
`/profile`. Rationale: backend v1 already de-scoped media (§C deferred), mitm/tunnels,
embedded-provider OAuth; UI must not carry surface for non-existent API.

## 2026-09-17 — Keep list (tentative — pending user ratification)

Keep: Endpoint/home (trimmed), Providers (+ compatible-node modal, merged `/providers/new`),
Combos (DnD builder), Usage (Overview/Details/Logs tabs), Console Log (SSE), Token Saver,
Proxy Pools (CRUD/test/health), Settings (trimmed profile).
Open sub-questions: relay-deploy modals, translator debugger (v2?), quota as tab vs page.

## 2026-09-17 — Merge thin pages into their parents (tentative)

`/providers/new` → modal on Providers. `/endpoint` → home. `/quota` → Usage tab or
standalone: TBD in IA proposal.

## 2026-09-17 — Proxy-pools relay deploy deferred to v2 (user-ratified)

v1 proxy pools = CRUD + test + health-check + batch import. Vercel/Cloudflare/Deno
relay deployment modals deferred to v2 as their own phase. Revisit: backend contract
request needed before any UI work.

## 2026-09-17 — Translator debugger = v2 candidate (user-ratified)

Out of v1. Blocked on a backend step-log API (→ contract-requests.md when v2 nears)
and a monaco-class editor dep. Re-evaluate with request-log quality in practice.

## 2026-09-17 — Quota lives inside Usage (user-ratified)

Usage page tabs: Overview / Details / Quota. No standalone Quota nav item.
Progress-bar pattern retained.

## 2026-09-17 — v1 strategy: rebuild lean SPA (user-ratified)

Reuse-first-then-replace is dead: the reuse asset (working OAuth flows) does not exist
in v1 scope (zero embedded providers); upstream UI is welded to ~100 /api/* routes vs
§5's ~20 (shim/fork tax); rejected deps (SAML, sql.js, embedded express, i18n×10) are
upstream requirements. Rebuild = 8 screens over ~20 endpoints, ~3-4k LOC. Hybrid
survives as pattern-theft only (console SSE protocol, DnD builder, quota bars,
drill-down drawer, status filter). Evidence: ia-proposal.md §3.

## 2026-09-17 — UI stack: Vite + React + TS + Tailwind (user-ratified)

No Next.js. TanStack Query (API state), recharts (charts), dnd-kit (combo builder).
Static build served by re-e-core at /ui/*, standalone Vite dev server for development.
No SSR/SEO/route-server needs; Next would re-import the process-weight problem the
split exists to remove.

## 2026-09-17 — Design system authored, Level 3 (settled per designer-role instruction)

`DESIGN.md` (light) + `DESIGN.dark.md` (dark = primary target) in `docs/ui-ux/`,
following the DESIGN.md spec: YAML frontmatter SSOT, full 10-step scales (gray,
gray-alpha, blue/green/amber/red/purple), typography Inter + JetBrains Mono at 13-14px
base (dense), 4px spacing, radius family 6/10/14/pill, component tokens (buttons,
inputs+mono, card, badges, nav, table, log-line, code-chip), elevation/motion/shapes/
voice defined. Status semantics: green=healthy, amber=degraded, red=breaker-open,
blue=interactive, purple=RTK. Migration note: files move to `re-e-ui/` root when the
package exists. Fonts: Inter + JetBrains Mono (bundled locally, no CDN dependency).

## 2026-09-17 — Component vocabulary v1 (settled with DESIGN.md)

Button, Input(+mono), Card, Badge, Modal, Drawer, Tabs, Toggle, Select, Tooltip,
Table(dense), LogStream, EmptyState, Toast, NavRail, StatusDot, CopyChip — 17
primitives cover all 8 screens; charting (recharts) and DnD (dnd-kit) are external
special-cases, not primitives.

## 2026-09-17 — Preview slice v0.1 shipped (settled)

`re-e-ui/` scaffolded per agreed repo layout (this branch; merges clean as new
directory). Vite 7 + React 19 + TS strict + Tailwind v4. Screens live: NavRail (IA
groups), Overview (endpoint strip, 5 stat cards, node health cards, failures table,
empty state), Add Upstream modal (name/baseUrl/key/prefix + Test Connection with
contract-shaped result). Mock transport in `src/api/mock.ts` typed to contract
shapes — swap for real fetch client against §5 without touching screens.

Verified: full flow in headless browser (add node → 200·52ms·14 models → save →
4 nodes; Reset Breaker → breaker-open cleared). Computed-style QA matches
DESIGN.dark.md tokens exactly (bg #0c0c0e, light-fill primary, blue-100 nav,
green-800 badge, mono data with tabular-nums, 6/10/14px radii, 13px base, Inter +
JetBrains Mono bundled locally). Screenshots in `re-e-ui/.preview/`.

Implementation note: Tailwind v4 via `@tailwindcss/postcss` — the `@tailwindcss/vite`
plugin (4.3.3) expanded imports but compiled zero utilities on this Windows/Vite 7
setup; postcss route verified by build output. `fonts.check` false-negatives on
variable fonts are a known quirk; computed styles confirm real loading.

## 2026-09-17 — Visual identity follows upstream 9Router (user override)

User instruction: prefer the original 9Router layout, blocking, and style over the
authored design system. Source recon of upstream `globals.css` + `DashboardLayout` +
`Sidebar` + `Header` + primitives (Button/Card/Badge/Modal/Input/ThemeToggle), ported
verbatim into re-e-ui: brand coral #E56A4A scale, warm dark surfaces (#1a1a1a/#262626),
header-carried page titles + descriptions, w-72 vibrancy sidebar with traffic lights +
gradient logo, `landing-grid` background, `p-6 lg:p-10` + `max-w-7xl` content, upstream
Button/Card/Badge/Modal (traffic-light header)/Input classes, material-symbols icons
(ligature + fill-1 active states), top-right toast stack, upstream scrollbars/selection.
`DESIGN.md`/`DESIGN.dark.md` marked SUPERSEDED (kept as rejected-alternative record);
token SSOT for code = upstream globals.css mirrored in `re-e-ui/src/index.css`.

Re-verified after restyle: connect flow end-to-end (fill → Test Connection →
200·137ms·21 models → save → node count grows; Reset Breaker → toast, breaker-open
cleared). Computed-style QA matches upstream tokens exactly. IA/screen cuts from the
brainstorm remain unchanged — only the visual identity + blocking changed.

Implementation notes: `material-symbols` is CSS-only → must stay in vite
`optimizeDeps.exclude` (dep optimizer chokes on it and reload-loops); tailwind v4
stays on `@tailwindcss/postcss`.

## 2026-09-17 — Theme adopted: Graphite Pro (user-ratified)

User picked candidate A from the visual catalog. `index.css` promoted: `.dark` =
Graphite dark (`#0F1115/#181D26` surfaces, `#4D9DFF` accent, status `#3DD68C`/
`#F5B93F`/`#F0564E`), `:root` = matching light twin (`#F7F8FA`, `#2E7FE0` accent) —
ThemeToggle now fully functional. `brand-*` scale remapped coral → blue ramp so the
sidebar gradient + any brand utilities follow the accent. `scheme-ember` class
preserves the upstream palette as a catalog candidate; all 7 genre panels remain
previewable at /theme. Verified: dark + light computed styles, toggle round-trip,
Overview + Theme Lab intact.

Extras ratified in the same pass (from the catalog page): latency sparklines and
`kbd` hints now ship with the shell; ⌘K palette, density toggle, skeletons = v1.1.
Data font default remains the system mono stack pending JetBrains Mono adoption
(comparable in the lab; ligatures off for keys/URLs regardless).

## 2026-09-18 — Identity patch shipped (all recs, user-ratified)

Per `identity-patch-plan.md`, all six decisions taken as recommended:
- **D1/D2 type:** UI = IBM Plex Sans Variable, data = IBM Plex Mono,
  display accent (stat numerals + wordmark only) = Space Grotesk Variable. All
  bundled locally via fontsource; Inter and Material Symbols removed.
- **P1 traffic lights:** deleted from sidebar, modal headers, and CSS. Modal is
  now a clean card: title left, ghost X right, tinted footer rule.
- **D3 icons:** Material Symbols ligature font → Phosphor SVG (`@phosphor-icons/react`).
  Same thin-outline style, different formation. Ripple removals: ~3.5MB symbol font,
  `.fonts-loaded` opacity hack + `fonts.ready` listener, `optimizeDeps.exclude`
  entry, and the icon-name-in-`textContent` problem ("addAdd Upstream") that made
  browser automation unreliable — exact-match selectors work again (verified).
- **D4 nav formation:** option 1 — no background plate; active = 2px accent tick
  on the rail edge + icon weight flip regular→fill + semibold label.
- **D5 decoration:** card bezel inset (`--shadow-soft` gains
  `inset 0 1px 0 white@4.5%` dark / 60% light), active rail tick, sparkline 8%
  accent area fill, Space Grotesk tabular stat numerals. Header activity hairline
  deferred to v1.1 (needs the SSE log endpoint); section-rule labels not taken.
- **D6 modal header:** standard title + ghost X.

Also: `Button.loading` now renders an SVG `Spinner` (verified visible during
Test Connection); unused `EmptyState` primitive deleted; theme-catalog `scheme-ember`
retains upstream values so all 7 candidates stay previewable at `/theme`.

Verification: `tsc --noEmit` clean; `vite build` clean (Plex Sans/Mono + Space
Grotesk subsets emitted); computed QA — body font `IBM Plex Sans Variable`,
`font-mono` → `IBM Plex Mono`, `.font-display` → `Space Grotesk Variable`, 18 SVG
icons, 0 `.material-symbols-outlined`, 0 traffic lights, `textContent` === 
`"Add Upstream"` exactly, inset bezel present, active tick present; full add-upstream
flow re-run green (`200 · 103ms · 15 models` → 4 nodes; breaker reset toast).
Screenshots `.preview/01–04*.png`.

Carried to v1.1: ⌘K command palette, density toggle (40↔32px rows), skeleton
loaders, header activity hairline, icon-only collapsible rail.

## 2026-09-18 — All v1 screens built against the live gateway (settled)

Merged `axolotl` (no conflicts; identity patch preserved). Transport is live by
default (`client.ts` + `transport.ts`); `mock.ts` re-purposed as a **fresh-install
simulator** (`VITE_API_MODE=mock`) so empty states stay testable without a gateway.

**Built:** Upstreams (dense table, status filter tabs + search, per-node Test/Reset/
Keys/delete-confirm, connections drawer with masked keys), Usage (URL-synced tabs:
Overview with recharts 24h hourly series + metric switch, Details with history table
→ drawer of REQUEST/RESPONSE payloads, Quota = token-share-by-node bars + explicit
disclaimer that provider quotas don't exist in v1), Live Console (SSE init snapshot +
live line events, JSON parse, level chips + tag select derived from the buffer,
follow/pause, view-local clear, ring at 2000 with ~10fps coalescing), Combos & Aliases
(dnd-kit ordering with keyboard Arrow up/down fallback, unsaved badge + Save, strategy
select, alias CRUD, routable-name suggestions from `GET /v1/models`), Proxy Pools
(CRUD, enabled toggle, per-URL test results), Token Saver (RTK master switch + honest
notes), Settings (gateway chip row, requireApiKey toggle, key table with the
show-once plaintext panel, appearance), and Overview re-pointed at `GET /api/gateway`
with ISO timestamps formatted and no failure section when there are no failures.
`/upstreams|/usage|/console|/combos|/pools|/token-saver|/settings` routed.

**Verified against the running gateway** (power cut mid-session; both processes
relaunched, `re-e-core` needs `npm install` in this worktree — deps are not shared
between worktrees): fresh install renders zeros/empty states on every screen; created
a node through the modal (probe surfaced the real `HTTP 404`), combo + alias through
the UI, client key through Settings (plaintext shown once → verified absent from the
DOM afterwards → row persists), then broke a node on purpose to prove live SSE
(0→2 `warn` CHAT lines while mounted, `CHAT` appears in the tag filter, tag filter →
3, warn off → 0 + empty state) and real breaker status in Upstreams. Temporary nodes
and keys were deleted afterwards; production build also verified served **by the
gateway itself** at `http://127.0.0.1:8010/` (same-origin, no dev proxy).

**Dev loop note:** `vite.config.ts` now proxies `/api` and `/v1` to `127.0.0.1:8010`;
`/v1` is only needed for the model-suggestion list.

**Follow-ups filed:** round 2 of `contract-requests.md` — node `PUT`/enable,
`usageEventId` on details, connection delete, key enable toggle, request-path
info-level logs (a healthy gateway's console is empty today), BOOT via
`log.info` + cleartext `bootstrapToken` in boot output, combo `<combo>/<model>`
semantics question, and whether `GET /v1/models` is intentionally public.

**Also fixed:** Combos suggestion copy no longer blames the gateway for an empty
install (tri-state: loading / reachable-empty / unavailable-with-reason).

## 2026-09-19 — Supervisor recovery incident (02:0x local)

`ree-core`, `ree-stub`, `ree-ui-dev` all reported exit. Sequence, with the two
conclusions that matter for how we run this stack:

1. **Orphan + EADDRINUSE, not a gateway crash.** The hub-tracked launch died with
   its wrapper, but the Windows node child survived holding 8010; the
   `restart=on-failure` policy then spawned attempts that each threw an unhandled
   `EADDRINUSE` and exited 1 (8 restarts). Read "crash loop", actually a stale
   supervisor. Fixed by stopping the job, `Stop-Process` on the orphan, then
   starting fresh; all three are now `persist: true` so client teardown stops
   killing them. Filed as §6b: the gateway should fail with one human line + a
   pid in the boot record, not a stack.
2. **My async probes were the bug, twice.** Backgrounded `bash` jobs in this
   environment have no `curl` (and a different `/tmp`), so a `if ! curl …` liveness
   loop reports "DOWN" on its first poll every time. Two false "the core died
   again" calls came from that. Use `node -e` with `fetch` for background probes.
   Real measurement: 120 × `GET /api/health` at 500 ms → p50 16 ms, p95 17 ms,
   max 39 ms, 0 failures. Gateway was healthy throughout.

Also corrected §5 of `contract-requests.md`: request lines *do* exist at `debug`
(`FETCH demo ← 200 ttft=19ms` appeared live in the ring), so the accurate claim is
"nothing at the default `info` level" — the ask (an info-level per-request line)
stands, my earlier framing was wrong. `requestsToday` proved to be
local-midnight-based with batched-write lag (§6c).

State left: nodes `[demo]`, `dev-combo`, `smart` alias, **no API keys** (both
verification keys deleted; the plaintext of yesterday's `re_2aca…` never existed
outside my session, so mint your own through Settings). `Gate Test` vanished
between two reads — main's session edits the same `~/.re-e` DB, so screens must
tolerate config changing underneath them (they do: react-query refetch on window
focus, no cached-write assumptions).

## 2026-09-19 — Round 3: merged backend, wired the newly-unlocked operations (settled)

Merged `axolotl` (round-2 backend). Every affordance that was deliberately absent for
missing routes is now live: **Edit upstream** (the add-modal in edit mode over
`PUT /api/nodes/{id}`, blank key = keep), **Disable/Enable** per node, keys drawer
**priority** (blur-to-save) and **remove key** with confirm, Settings **Revoke /
Enable** per client key, Live Console **server-side level** (the level chips derive a
`?level=` floor when the enabled set is a suffix of debug<info<warn<error, otherwise
they filter in-view) and a **real Clear** (`POST /api/logs/clear` → `clear` broadcast →
every open console resets). Combos copy rewritten for bare-name addressing.

`transport.ts` now types the swap as `typeof liveApi`, so the mock transport fails the
build if it drifts from the real surface — it was silently missing five methods before
I pinned it. `useDetailsForEvent` correlates the payload drawer by `usageEventId` with
the old millisecond fallback kept (the column is NULL today; see R3-5).

**Verified in the browser, not just by reading code:** created → renamed via PUT →
disabled → enabled → added a second key → set priority (persisted 100→3→100, read back)
→ removed key → minted key → revoked (proxy returned **401**) → re-enabled (**200**) →
deleted; console badge moved to `?level=info` when debug was switched off and the
ring-empty state after Clear. All test rows deleted afterwards: `nodes [Demo Stub/demo]`,
`keys []`, `combos [dev-combo]`, `alias {smart}` — the shared DB is back to its
pre-session state.

**UI fixes made on evidence:** toast stack gained `role="status" aria-live="polite"`
(feedback was invisible to assistive tech — and to my own probes); `utils/errors.ts`
maps storage text to intent, because a duplicate prefix arrives as
`internal_error · UNIQUE constraint failed: provider_nodes.prefix`, and that string must
not be user-facing (raw kept in `console.warn`). Console empty-state copy rewritten: with
R3-1 open, silence does **not** mean no traffic, and the screen now says so.

**Filed as round 3:** R3-1 REQ line never fires (the healthy console is still empty;
likely scope slip between `recordSuccess` and `recordUsage`), R3-2 duplicate-prefix 500
leaking SQLite, R3-3 intermittent `PUT /api/nodes` 500 *after* commit with no server
trace, R3-4 disabled nodes still serve 200, R3-5 `usage_event_id` NULL everywhere,
R3-6 one-DB-one-gateway guard (a real consequence: a probe of mine deleted another
session's API key when row ordering shifted between two reads). Withdrawn: the
`bootstrapToken` redaction ask — it is now stdout-only by design and out of the ring.

**Ops:** gateway restarted on post-merge code, single supervisor (`ree-core`,
`persist: true`), default log level this time — the level is now part of what we are
testing. Note `hub send` to `Main` is this session, so cross-session coordination goes
through the user.
