# RE-E UI — IA Proposal + v1 Strategy Verdict (brainstorm steps 2–3)

> 2026-09-17. Evidence base: `upstream-dashboard-inventory.md`. Scope pinned by
> DECISIONS.md (media/mitm/pxpipe/skills/chat cut; relay deploy v2; translator v2;
> quota inside Usage).

## 1. IA — screens (8 total)

| # | Screen | Route | Contents |
|---|---|---|---|
| 1 | **Overview** (home) | `/` | Gateway endpoint URL + key (copy), health summary cards per upstream (breaker state, last error, reset button), today's mini-stats (requests, tokens, cost, error rate), recent failures list. Empty state = big "Connect your first upstream" CTA |
| 2 | **Upstreams** | `/upstreams` | Node list (compatible nodes: baseUrl + key + prefix), status/test badges, add/edit modal, per-node test button, alias assignment. API keys managed here (per-node + client keys) |
| 3 | **Combos & Aliases** | `/combos` | Combo builder with drag-drop model ordering (dnd-kit pattern), per-combo strategy select, alias editor (alias → combo/model mapping). No capacity adapter in v1 (v2) |
| 4 | **Token Saver** | `/token-saver` | RTK config per §B: enable, level presets, preview of transformation. Other savers (headroom/caveman/ponytail) as disabled-but-visible v2 rows |
| 5 | **Proxy Pools** | `/pools` | Pool CRUD, proxyUrl/noProxy/strict fields, per-pool test, batch import, health-check with progress (concurrency pattern stolen). No relay deploy (v2) |
| 6 | **Usage** | `/usage` | Tabs **Overview / Details / Quota**. Overview: recharts tokens/cost area chart + group-by tables (model/node/key). Details: request drill-down table → row opens right-side drawer with full breakdown (timing incl. TTFT, tokens incl. cache, combo/node used, error). Quota: per-connection progress bars |
| 7 | **Live Console** | `/console` | SSE stream, level coloring, ring buffer, pause/clear, filter by level/node, click request-id → deep-link into Usage drawer |
| 8 | **Settings** | `/settings` | Theme (dark default), density, fallback/combo strategy defaults, config export/import (config-as-file alignment), shutdown/restart. No SSO/password/DB-auth |

**Nav model:** left rail, two groups + footer item:
- **Gateway:** Overview · Upstreams · Combos & Aliases · Token Saver · Proxy Pools
- **Insights:** Usage · Live Console
- Footer: Settings (+ version + gateway online/offline dot)

Global elements: command palette slot (v2), notification toasts, per-screen header search
on Upstreams/Usage (stolen pattern).

## 2. Primary flows

**Connect upstream in <60s:** Overview → "Add upstream" (header button + empty-state CTA)
→ single modal: name · baseUrl · API key · model prefix (auto-probe `/v1/models` for
suggestions) → inline Test → Save. One modal, four fields, no wizard. Land back on
Overview/Upstreams with live health card.

**Find a slow request in <3 clicks:** nav **Usage** (1) → **Details** tab (2) → row
click → drawer (3) with TTFT + per-node timing. Details default-sorted by duration on
the "slow" quick-filter. Console cross-link: request-id in a log line jumps straight to
the drawer (also 3 clicks from Console).

**Breaker reset:** Overview health card or Upstreams row → reset button → toast.

## 3. v1 strategy verdict: **rebuild lean SPA** (kill "reuse-first")

The brief's default thinking was reuse-the-Next-dashboard-out-of-process, then replace.
Pressure-tested — it fails on v1 scope:

1. **The reuse asset doesn't apply.** Upstream's "fast, working OAuth flows" is the
   reuse argument — but RE-E v1 has **zero embedded providers**. There are no OAuth
   flows to reuse. The must-list is custom nodes + management API only.
2. **The API seam diverges deliberately.** Upstream UI fetches ~100 `/api/*` routes
   (oauth/*, cli-tools/*, mitm/*, media, translator, sync, updater). §5 ships ~20 and
   drops the rest. Reuse = shim layer emulating dropped routes, or maintaining a fork
   of a 13k-LOC dashboard we don't own.
3. **Dep weight is the reason for the split.** SAML, sql.js, embedded express,
   i18n×10, monaco, xyflow are upstream requirements RE-E explicitly rejects.
4. **Rebuild is small.** 8 screens over ~20 management endpoints ≈ 3–4k LOC.

Hybrid survives as: **steal the inventoried patterns, not the code** (console-log SSE
protocol, DnD builder, quota bars, drill-down drawer, status filter).

### Stack recommendation (for DECISIONS ratification)

**Vite + React + TypeScript + Tailwind** (v4), TanStack Query for API state, recharts
(charts), dnd-kit (combo builder). No Next.js — no SSR/SEO/route-server needs for a
local dev tool; Next would re-import the process-weight problem. Deployment: static
build served by `re-e-core` (`/ui/*`) with the SPA also runnable standalone for
development; dark-first, dense, monospace-friendly tokens per step 4.
