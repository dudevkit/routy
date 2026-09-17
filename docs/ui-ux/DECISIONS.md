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
