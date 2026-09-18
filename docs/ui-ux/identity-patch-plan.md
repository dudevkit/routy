# RE-E UI — Identity Patch Plan (brainstorm, 2026-09-18)

> Status: **plan only — nothing built.** Decisions D1–D6 pending user call.
> Baseline: Graphite Pro base theme + upstream blocking, both approved.
> Goal: remove the remaining 9Router fingerprints, keep the approved structure.

## P1 — Remove macOS traffic lights

Appears in **three** places; all go:

| Place | Today | After |
|---|---|---|
| Sidebar top | decorative 3-dot row above the logo | delete; logo block becomes the rail's top anchor (`pt-6`) |
| Modal header | red close dot + 2 inert dots | standard header: title left, ghost `✕` icon-button right, hairline rule under |
| `index.css` | `.traffic-lights` / `.traffic-light` rules | dead code, delete |

Also drop the `showTrafficLights` prop from Modal. macOS-window cosplay is the
single most "9Router" gesture left — removing it costs nothing structurally.

Replacement signature (see P4/D5): a thin **accent tick** on the rail's left edge
at the active nav item — our own chrome anchor instead of borrowed chrome.

## P2 — Type change (D1, D2)

Current UI font is Inter — the same face upstream ships, so it reads as inherited.

**Recommended: IBM Plex Sans (UI) + IBM Plex Mono (data).**
- Engineered for technical instrumentation, not marketing UI: generous x-height,
  unambiguous `0O`/`1lI`, distinctive `g`/`l`/`1` — reads as "console", not "Inter app".
- One superfamily covers UI + data → coherent DNA across labels and tokens/URLs;
  IBM Plex Mono is already installed for the Theme Lab, so the mono half is done.
- Variable + local (`@fontsource-variable/ibm-plex-sans` 5.3.0 verified), no CDN,
  `tnum` available for tables.
- Metric caveat: Plex is slightly wider than Inter at 13px — expect to re-check
  truncation in node cards + nav labels; may want 12.5px in dense tables.

| Option | Verdict |
|---|---|
| **IBM Plex Sans + Plex Mono** | **rec** — most character at small sizes for an infra tool |
| Geist Sans + Geist Mono | runner-up — quieter, premium; but Inter-adjacent, so weaker de-9Router-ing |
| Hanken Grotesk / Public Sans | tier-B — fine, less instrument-like |
| Manrope | avoid — soft roundness fights an instrument panel |
| Inter | avoid — upstream's own choice |

**D2 — display accent (optional, small):** **Space Grotesk** used *only* for stat
numerals + the sidebar wordmark (2 tokens, nothing else). Adds identity cheaply;
skip if we want one-family purity.

Data-font rule stays: **no ligatures** in keys/URLs.

## P3 — Icon system: same style, different formation (D3)

Interpretation of "change the way its formed": keep the thin-outline look, stop
*forming* icons as font ligatures, form them as drawn SVG paths.

**Recommended: Phosphor Icons (`@phosphor-icons/react` 2.1.10).**
- Outline style matches what's approved; geometry is its own.
- **Weight axis (100–900) + `fill`** = direct replacement for Material's `fill-1`
  active-nav affordance (active nav icon flips regular→fill). Lucide/Tabler can't do
  filled variants — active state would degrade to color only.
- Per-icon ESM → tree-shaken, ~0 weight concern; MIT.

Runner-up: Tabler Icons (3.46.0) — most "technical" linework, but no fill variants.
Lucide (1.47.0) — most popular, least distinctive, no fill.

**Ripple benefits of dropping Material Symbols (real, not cosmetic):**
- removes the ~3.5MB symbol font + `@import "material-symbols"`
- removes the `.fonts-loaded` opacity hack and the `fonts.ready` listener in `main.tsx`
- removes `optimizeDeps.exclude: ["material-symbols"]` from `vite.config.ts`
  (that package is CSS-only and broke Vite's dep optimizer earlier)
- icon names stop leaking into `textContent` — the "addAdd Upstream" mess that
  made browser automation unreliable is structurally impossible with SVG icons

**Cutover scope:** `Button.icon` / `Badge.icon` props go `string → ReactNode`;
rewrite icon sites in Sidebar, Header, Card, Input, Button, Badge, Modal, Toast,
Overview, Stub, ThemeSampler. Icon map:

| Screen | Material | Phosphor |
|---|---|---|
| Overview | `space_dashboard` | `SquaresFour` |
| Upstreams | `dns` | `Broadcast` |
| Combos & Aliases | `layers` | `Stack` |
| Usage | `bar_chart` | `ChartBar` |
| Token Saver | `savings` | `Coins` |
| Proxy Pools | `lan` | `Network` |
| Live Console | `terminal` | `TerminalWindow` |
| Theme Catalog | `palette` | `Palette` |
| Settings | `settings` | `Gear` |
| logo | `hub` | `NodeJs`/`HierarchyBreak` |
| actions | `add` / `delete` / `content_copy` / `check` / `network_check` / `restart_alt` / `light_mode` / `dark_mode` / `progress_activity` | `Plus` / `Trash` / `Copy` / `Check` / `WifiHigh` / `ArrowsClockwise` / `Sun` / `Moon` | spinner = CSS ring, not a glyph |

Sizing: render at 16–18px, `weight="regular"`, `size` explicit; nav 18px, buttons 16px.

## P4 — Nav item formation (D4)

Keep label type, spacing rhythm, active color logic. Change *how each row is built*:

| Option | Construction | Read |
|---|---|---|
| **1 · Left bar + filled icon** | **rec** — no background tint; active = 2px accent bar on rail edge + icon flips to `fill` + text to `text-main`; inactive hover = text only | quietest, densest, Linear-grade; pairs with P1 replacement tick |
| 2 · Icon tiles | each icon in a 24px `rounded-[6px] bg-surface-2` micro-tile; active tile tints accent | "instrument panel" rhythm, slightly heavier |
| 3 · Mono index rows | `01 Overview` — mono index + icon + hairline separators | operator-console flavor; risk: gimmick fatigue |
| 4 · Collapsible rail | icon-only 64px mode + tooltips, persisted | density win — propose as v1.1, not now |

Recommend **1**, optionally **1 + 3's hairline separators** between groups.
Groups keep the upstream Model: main list + `SYSTEM` section label.

## P5 — Decoration patch (D5) — pick any subset

Small, Graphite-native, no gradients/glass:

1. **Card bezel** — dark-only `inset 0 1px 0 rgba(255,255,255,0.045)` on `.card-soft`:
   subtle instrument depth, no visual weight. *rec*
2. **Rail activity tick** — the active-item accent bar (P4 opt 1) doubles as this. *rec*
3. **Sparkline area fill** — accent at 8% under the stroke: volume, not just a line. *rec*
4. **Header activity hairline** — 1px accent line under `<header>` that lights briefly
   on SSE request activity; static when idle. *nice, needs the log stream (v1.1) — defer*
5. **Stat numeral treatment** — data font + `tnum` + `tracking-tight` at 20px (mostly
   already there; formalize as a `Stat` primitive when Upstreams lands). *rec*
6. **Section rule labels** — `SYSTEM`-style uppercase micro-labels get a 1px trailing
   hairline across the rail width. *optional*

Avoid: aurora glows, surface gradients, translucent panels — they tax dense tables.

## P6 — Effort + sequencing (once decisions land)

| Step | Files | Nature |
|---|---|---|
| a. Traffic-light removal | Sidebar, Modal, index.css | delete-only |
| b. Font swap | main.tsx, index.css (`--font-sans`), package.json | token-level, then truncation sweep |
| c. Icon system swap | package.json, vite.config, index.css, main.tsx + 11 icon sites | mechanical, prop type `string → ReactNode` |
| d. Nav formation | Sidebar (NavItem) | one component |
| e. Decoration subset | index.css, Sparkline, Card | 4–6 small rules |

Contiguous single-pass change; no logic/API/mock changes. Verification = tsc +
headless QA (computed styles) + screenshot diff vs today.

## Decisions needed

- **D1** UI+data font: IBM Plex Sans + Plex Mono? *(rec)*
- **D2** Space Grotesk as numerals/wordmark accent? yes/no
- **D3** Icon set: Phosphor? *(rec — needs fill variants)* else Tabler / Lucide
- **D4** Nav formation: option 1 (left bar + filled icon)? *(rec)* 2 / 3 / 1+3
- **D5** Decoration subset: which of 1,2,3,5,6 (4 deferred to v1.1)
- **D6** Modal header: confirm standard title + ghost ✕ (no window chrome)
