---
version: 0.1.0
name: "RE-E Design"
description: "RE-E Design is a dense, dark-first, monospace-friendly design system for the RE-E gateway dashboard. This is the Light theme; the Dark theme (primary target) lives at ./DESIGN.dark.md."

colors:
  # ── Background surfaces ──
  background-100: "#ffffff"
  background-200: "#fafafa"
  background-300: "#f4f4f5"

  # ── Gray (solid — text and opaque fills) ──
  gray-100: "#f4f4f5"
  gray-200: "#e4e4e7"
  gray-300: "#d4d4d8"
  gray-400: "#a1a1aa"
  gray-500: "#71717a"
  gray-600: "#52525b"
  gray-700: "#3f3f46"
  gray-800: "#27272a"
  gray-900: "#18181b"
  gray-1000: "#09090b"

  # ── Gray alpha (translucent overlays, borders, dividers) ──
  gray-alpha-100: "#00000008"
  gray-alpha-200: "#0000000f"
  gray-alpha-300: "#00000017"
  gray-alpha-400: "#00000021"
  gray-alpha-500: "#00000033"
  gray-alpha-600: "#0000004d"
  gray-alpha-700: "#00000073"
  gray-alpha-800: "#00000099"
  gray-alpha-900: "#000000c2"
  gray-alpha-1000: "#000000e5"

  # ── Blue (links, focus, primary actions, selection) ──
  blue-100: "#eff6ff"
  blue-200: "#dbeafe"
  blue-300: "#bfdbfe"
  blue-400: "#93c5fd"
  blue-500: "#60a5fa"
  blue-600: "#3b82f6"
  blue-700: "#2563eb"
  blue-800: "#1d4ed8"
  blue-900: "#1e40af"
  blue-1000: "#172554"

  # ── Green (healthy, breaker closed, test passed) ──
  green-100: "#ecfdf5"
  green-200: "#d1fae5"
  green-300: "#a7f3d0"
  green-400: "#6ee7b7"
  green-500: "#34d399"
  green-600: "#10b981"
  green-700: "#059669"
  green-800: "#047857"
  green-900: "#065f46"
  green-1000: "#064e3b"

  # ── Amber (degraded, rate-limited, quota low) ──
  amber-100: "#fffbeb"
  amber-200: "#fef3c7"
  amber-300: "#fde68a"
  amber-400: "#fcd34d"
  amber-500: "#fbbf24"
  amber-600: "#f59e0b"
  amber-700: "#d97706"
  amber-800: "#b45309"
  amber-900: "#92400e"
  amber-1000: "#78350f"

  # ── Red (error, breaker open, destructive) ──
  red-100: "#fef2f2"
  red-200: "#fee2e2"
  red-300: "#fecaca"
  red-400: "#fca5a5"
  red-500: "#f87171"
  red-600: "#ef4444"
  red-700: "#dc2626"
  red-800: "#b91c1c"
  red-900: "#991b1b"
  red-1000: "#7f1d1d"

  # ── Purple (RTK / token-saver transforms) ──
  purple-100: "#faf5ff"
  purple-200: "#f3e8ff"
  purple-300: "#e9d5ff"
  purple-400: "#d8b4fe"
  purple-500: "#c084fc"
  purple-600: "#a855f7"
  purple-700: "#9333ea"
  purple-800: "#7e22ce"
  purple-900: "#6b21a8"
  purple-1000: "#581c87"

typography:
  heading-24:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 600
    lineHeight: 30px
    letterSpacing: -0.01em
  heading-20:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.01em
  heading-16:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: 0
  label-14:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  label-13:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0
  label-12:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0.01em
  copy-14:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22px
    letterSpacing: 0
  copy-13:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  button-14:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: 0
  button-13:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
    letterSpacing: 0
  copy-13-mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  label-12-mono:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0
  label-11-mono:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0.02em

spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  10: 40px
  16: 64px
  24: 96px

rounded:
  sm: 6px
  md: 10px
  lg: 14px
  full: 9999px

components:
  button-primary:
    backgroundColor: "{colors.gray-1000}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
  button-secondary:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
    borderColor: "{colors.gray-alpha-400}"
  button-tertiary:
    backgroundColor: transparent
    textColor: "{colors.gray-700}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
  button-error:
    backgroundColor: "{colors.red-700}"
    textColor: "#ffffff"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
  button-small:
    typography: "{typography.button-13}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: 26px
  input:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.label-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
    borderColor: "{colors.gray-alpha-400}"
  input-mono:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.label-12-mono}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
    borderColor: "{colors.gray-alpha-400}"
  input-small:
    typography: "{typography.label-13}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: 26px
  card:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    rounded: "{rounded.lg}"
    padding: "16px"
    borderColor: "{colors.gray-alpha-300}"
  card-compact:
    padding: "12px"
  badge-success:
    backgroundColor: "{colors.green-100}"
    textColor: "{colors.green-800}"
    typography: "{typography.label-11-mono}"
    rounded: "{rounded.full}"
    padding: "1px 8px"
  badge-warning:
    backgroundColor: "{colors.amber-100}"
    textColor: "{colors.amber-900}"
    typography: "{typography.label-11-mono}"
    rounded: "{rounded.full}"
    padding: "1px 8px"
  badge-error:
    backgroundColor: "{colors.red-100}"
    textColor: "{colors.red-800}"
    typography: "{typography.label-11-mono}"
    rounded: "{rounded.full}"
    padding: "1px 8px"
  badge-neutral:
    backgroundColor: "{colors.gray-alpha-200}"
    textColor: "{colors.gray-700}"
    typography: "{typography.label-11-mono}"
    rounded: "{rounded.full}"
    padding: "1px 8px"
  nav-item:
    textColor: "{colors.gray-600}"
    typography: "{typography.label-13}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    height: 28px
  nav-item-active:
    backgroundColor: "{colors.blue-100}"
    textColor: "{colors.blue-800}"
  table-header:
    backgroundColor: "{colors.background-300}"
    textColor: "{colors.gray-600}"
    typography: "{typography.label-12}"
    height: 32px
  table-cell-dense:
    typography: "{typography.copy-13-mono}"
    height: 32px
  log-line:
    backgroundColor: "{colors.gray-1000}"
    textColor: "{colors.green-500}"
    typography: "{typography.copy-13-mono}"
    padding: "1px 12px"
  code-chip:
    backgroundColor: "{colors.gray-alpha-200}"
    textColor: "{colors.gray-900}"
    typography: "{typography.label-12-mono}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
---

<!-- COMPLETENESS_LEVEL: 3 — last audited 2026-09-17 -->
<!-- SUPERSEDED 2026-09-17: user chose upstream 9Router visual identity for v1 (see DECISIONS.md). Token SSOT for code is now upstream `9router/src/app/globals.css`, mirrored verbatim in `re-e-ui/src/index.css`. This file is kept as the record of the rejected alternative and for v2 reconsideration. -->

# RE-E Design

## Overview

RE-E Design is a dense, dark-first, monospace-friendly design system for the RE-E
gateway dashboard — a local developer tool for routing AI traffic. Data is the hero:
models, URLs, keys, tokens, latencies render in monospace with tabular figures. Chrome
(controls, labels, prose) is quiet and secondary. Color carries state (health,
breakers, errors), never decoration.

This is the Light theme. The Dark theme — the **primary consumption target** — uses
the same token names with different values and lives at `./DESIGN.dark.md`.

> Location note: this file lives in `docs/ui-ux/` while the worktree owns docs only.
> When `re-e-ui/` materializes, these files migrate to `re-e-ui/DESIGN.md` +
> `re-e-ui/DESIGN.dark.md` (project-root contract).

## Colors

Token values are defined in the frontmatter `colors:` map. Each scale runs 10 steps
(`100`–`1000`) encoding intent:

- `100` default background · `200` hover background · `300` active background
- `400` default border · `500` hover border · `600` active border
- `700` solid fill, high contrast · `800` solid fill hover
- `900` secondary text/icons · `1000` primary text/icons

Gateway status semantics (never color alone — pair with label or icon):

| Token | Meaning |
|---|---|
| `green-*` | upstream healthy, breaker closed, test passed, proxy alive |
| `amber-*` | degraded, rate-limited, quota <20%, fallback in use |
| `red-*` | breaker open, error, upstream down, destructive actions |
| `blue-*` | interactive, selected, focus, links |
| `purple-*` | RTK / token-saver transform branding |
| `gray-*` | disabled, inactive, neutral state |

`background-100` = page, `background-200` = card, `background-300` = raised/active
surface. `gray-alpha-*` layers over any surface — borders, dividers, overlays, hover
states. Solid `gray-*` for text and opaque fills.

## Typography

Token naming `{role}-{size}`; `-mono` suffix = JetBrains Mono for data.

- **Headings** (`heading-24`…`heading-16`): page titles, section headers. No display
  sizes — this is a tool, not a landing page.
- **Labels** (`label-14`…`label-12`): nav, form labels, table headers, metadata.
- **Copy** (`copy-14`, `copy-13`): helper text, empty states, toasts.
- **Buttons** (`button-14`, `button-13`).
- **Mono**: `copy-13-mono` (logs, request drill-down), `label-12-mono` (URLs, keys,
  model ids, inputs), `label-11-mono` (badges, table meta). All numeric tables use
  `font-variant-numeric: tabular-nums`.

Base UI size is 13–14px — density is a feature.

## Spacing & Layout

Base unit 4px. Three-step rhythm: 8px inside a group, 16px between groups, 32px
between sections. Cards: 16px padding default, 12px compact, 24px hero. Layout is a
fixed 248px left rail + fluid content column, max-width 1200px for prose-ish screens
(Settings), full-bleed for data screens (Console, Usage Details).

### Breakpoints

| Name | Min Width | Target |
|------|-----------|--------|
| sm | 640px | Small windows / split view |
| md | 768px | Sidebar collapses to icons |
| lg | 1024px | Full sidebar (default) |
| xl | 1280px | Wide tables get extra columns |

Desktop-first; mobile is explicitly out of scope (dev tool).

## Elevation & Depth

Borders first, shadows second — dark surfaces flatten shadows.

| Element | Light value |
|---------|-------------|
| Card | none (border `{colors.gray-alpha-300}`) |
| Popover/Drawer | 0 1px 2px rgba(0,0,0,0.06), 0 8px 16px -8px rgba(0,0,0,0.12) |
| Modal | 0 2px 4px rgba(0,0,0,0.08), 0 16px 32px -12px rgba(0,0,0,0.18) |

Pair elevation with `rounded.lg` (14px) for cards/modals/drawers, `rounded.md` (10px)
for menus/popovers.

## Motion

Motion clarifies change, never decorates. Default is instant.

| Context | Duration | Easing |
|---------|----------|--------|
| State change (hover/active/toggle) | 120ms | ease-out |
| Popover/Tooltip/Drawer | 200ms | cubic-bezier(0.2, 0, 0, 1) |
| Modal/Overlay | 300ms | cubic-bezier(0.2, 0, 0, 1) |

Live-dot pulse (gateway online indicator) is the only looping animation: 2s subtle
opacity. Log stream auto-scroll must not animate. Honor `prefers-reduced-motion`.

## Shapes

| Context | Value |
|---------|-------|
| Buttons, inputs, chips | `rounded.sm` 6px |
| Nav items, menus, popovers | `rounded.md` 10px |
| Cards, modals, drawers | `rounded.lg` 14px |
| Badges, status dots | `rounded.full` |

One radius family per view.

## Components

Frontmatter `components:` is the SSOT for variant tokens. State rules:

- **Button states:** hover = fill steps up one (`gray-1000`→ darker overlay via
  `gray-alpha-200` in dark), active up two; secondary border `gray-alpha-400`→500→600.
- **Focus:** two-layer ring — `0 0 0 2px {colors.background-100}, 0 0 0 4px {colors.blue-700}` on `:focus-visible`.
- **Disabled:** `gray-alpha-200` fill, `gray-500` text, not-allowed cursor.
- **Inputs:** mono variant for baseUrl/key/prefix/model fields; inline test button
  sits inside the field row.
- **Badges** map 1:1 to status semantics table above.
- **Log line**: full-bleed dark strip, level-colored text (LOG green, INFO blue, WARN
  amber, ERROR red, DEBUG purple — mirrors upstream console pattern).

Vocabulary for v1 build (consumes the tokens above): Button, Input (+mono), Card,
Badge, Modal, Drawer, Tabs (SegmentedControl), Toggle, Select, Tooltip, Table
(dense), LogStream, EmptyState, Toast, NavRail, StatusDot, CopyChip.

## Voice & Content

- Title Case for labels, buttons, titles, tabs
- Sentence case for body, helper text, toasts
- Verb + Noun actions: `Add Upstream`, `Reset Breaker`, `Test Proxy`
- Errors: what happened + what to do: `Node unreachable. Check baseUrl and network.`
- Toasts: specific thing, no trailing period, no "successfully": `Upstream added`
- Empty states point to the first action: `No upstreams yet. Add one to start routing.`
- In-progress: present participle + ellipsis: `Testing…`, `Checking pool…`
- URLs, keys, model ids render in mono chips, never bare text

## Do's and Don'ts

- Use `gray-1000` for primary text, `gray-900` secondary, `gray-600` tertiary.
- Accent color for state + the single most important action per view.
- Hold WCAG AA (4.5:1 body). Test in dark first — it is the default.
- Show focus ring on every interactive element at `:focus-visible`.
- Never set font size/line-height/color by hand — frontmatter tokens only.
- Don't signal state with color alone.
- Don't exceed two font weights per view.
- Don't mix radius families in one view.
- Don't swap `gray-*` for `background-*`.
- Don't animate the log stream or data tables.
