# UI/UX Brainstorm Brief (seed for the ui-ux worktree)

> You are in the `ui-ux` worktree of the RE-E project. This file is your launching pad.
> Read order: `../docs/project-log.md` (state) → this file → `../docs/backend-architecture.md`
> §5 (the API seam) → upstream dashboard inventory (§3 here).

## What RE-E is (30 seconds)

Re-engineering of 9Router (local AI gateway) into a stable, lightweight backend + a
separate UI. The backend (`re-e-core`) is planned; **the UI/UX half is what this worktree
is for.** Project log: `../docs/project-log.md`. Never edit backend docs here except
through the merge discipline below.

## The decision space (from the project log)

1. **v1 UI strategy (open):** reuse the existing 9Router Next dashboard out-of-process
   (fast, ugly, working OAuth flows) vs rebuild a lean SPA (slow, ours). Not mutually
   exclusive: reuse-first-then-replace is the current default thinking. Brainstorm should
   pressure-test or kill this.
2. **What the UI must do** (from upstream's dashboard, trimmed to RE-E scope):
   - Connect upstreams (compatible nodes: baseUrl + key + model prefix) + API keys
   - Combos + aliases + provider node management
   - Usage: requests, tokens, cost, TTFT, per-node charts
   - Token-saver (RTK) config, settings
   - Live console/log view (SSE from backend)
   - Health/breaker status + reset
   - Proxy pools (user requirement — kept feature)
3. **What the UI must NOT need:** anything on the inference hot path. UI crash ≠ proxy
   crash. UI is a dev tool; the backend must be fully drivable without it (`re-e init`).

## The seam (what you design against)

Management API = `docs/backend-architecture.md` §5. Design freedom exists in:
- **Information architecture** (how the above groups into screens/nav)
- **Interaction patterns** (setup wizard vs forms, live log UX, usage drill-down)
- **Visual identity** (tokens, dark mode, density — a dev tool wants keyboard-friendly + dense)

## Ownership & merge discipline (binding)

| You own (ui-ux worktree) | Main worktree owns |
|---|---|
| `docs/ui-ux/**` — everything | `docs/roadmap.md`, `backend-architecture.md`, `db-design.md`, `provider-catalog.md`, `9router-reference.md` |
| UI decisions → `docs/ui-ux/DECISIONS.md` (append-only, dated) | `docs/project-log.md` (the SSOT) |
| API wishes → `docs/ui-ux/contract-requests.md` (never edit backend docs directly) | folding accepted requests into backend docs at merge |

Merge rhythm: commit to your branch freely; when decisions harden, they get merged to
`axolotl` (main branch) and folded into the project log — usually by the main session.

## Suggested brainstorm structure

1. Inventory what the upstream dashboard does per page (screenshots welcome) → keep/cut
2. IA proposal: nav model, screens, primary flows (connect upstream in <60s; find a slow request in <3 clicks)
3. v1 vs v2 verdict: reuse / rebuild / hybrid — with reasoning
4. Design tokens + component vocabulary if rebuilding (a coding-tool dashboard: dense, dark-first, monospace-friendly)
5. Log every settled decision in `DECISIONS.md` as you go

## Useful context pointers

- Upstream dashboard source: `9router/src/app/(dashboard)/` + `9router/src/shared/components/`
- Upstream dashboard weight (why we split): monaco, recharts, dnd-kit, SAML, i18n×10
- Upstream's good UX ideas worth stealing: cli-tools config writers (one-click CLI setup),
  quota progress bars, console log with per-session colors, combo drag-and-drop builder

## Process notes

- User instruction (2026-09-17): when building UI/UX code for preview — even throwaway
  preview builds — work in **designer role**: design-first (IA → tokens → component
  vocabulary → screens), visual/interaction quality is the deliverable. Don't hand
  preview builds off as engineer-default scaffolding.
