---
version: 0.1.0
name: "RE-E Design (Dark)"
description: "RE-E Design dark theme — the primary consumption target for the gateway dashboard. Same token names as DESIGN.md; only values differ."

colors:
  # ── Background surfaces ──
  background-100: "#0c0c0e"
  background-200: "#131316"
  background-300: "#1b1b1f"

  # ── Gray (solid — text and opaque fills; ramp inverted for dark) ──
  gray-100: "#1b1b1f"
  gray-200: "#232329"
  gray-300: "#2e2e35"
  gray-400: "#3f3f47"
  gray-500: "#52525b"
  gray-600: "#71717a"
  gray-700: "#a1a1aa"
  gray-800: "#d4d4d8"
  gray-900: "#e4e4e7"
  gray-1000: "#fafafa"

  # ── Gray alpha (white-based translucent overlays, borders, dividers) ──
  gray-alpha-100: "#ffffff08"
  gray-alpha-200: "#ffffff0f"
  gray-alpha-300: "#ffffff17"
  gray-alpha-400: "#ffffff21"
  gray-alpha-500: "#ffffff33"
  gray-alpha-600: "#ffffff4d"
  gray-alpha-700: "#ffffff73"
  gray-alpha-800: "#ffffff99"
  gray-alpha-900: "#ffffffc2"
  gray-alpha-1000: "#ffffffe5"

  # ── Blue ──
  blue-100: "#16233f"
  blue-200: "#1a2c4f"
  blue-300: "#1e3a66"
  blue-400: "#245099"
  blue-500: "#2f6fd0"
  blue-600: "#4b8dff"
  blue-700: "#5c9dff"
  blue-800: "#7db2ff"
  blue-900: "#a5ccff"
  blue-1000: "#e0efff"

  # ── Green ──
  green-100: "#0a2416"
  green-200: "#0d3320"
  green-300: "#11502f"
  green-400: "#167043"
  green-500: "#1f9e5c"
  green-600: "#2fce7d"
  green-700: "#34d399"
  green-800: "#6ee7b7"
  green-900: "#a7f3d0"
  green-1000: "#d1fae5"

  # ── Amber ──
  amber-100: "#2a1d05"
  amber-200: "#3d2a08"
  amber-300: "#5c3f0c"
  amber-400: "#7d560f"
  amber-500: "#b17a12"
  amber-600: "#f0a821"
  amber-700: "#fbbf24"
  amber-800: "#fcd34d"
  amber-900: "#fde68a"
  amber-1000: "#fef3c7"

  # ── Red ──
  red-100: "#2a0d0d"
  red-200: "#3d1212"
  red-300: "#5c1a1a"
  red-400: "#7f2222"
  red-500: "#b32f2f"
  red-600: "#ef4444"
  red-700: "#f87171"
  red-800: "#fca5a5"
  red-900: "#fecaca"
  red-1000: "#fee2e2"

  # ── Purple ──
  purple-100: "#241033"
  purple-200: "#33174a"
  purple-300: "#4c2170"
  purple-400: "#6a2e9c"
  purple-500: "#9445d9"
  purple-600: "#b565f7"
  purple-700: "#c084fc"
  purple-800: "#d8b4fe"
  purple-900: "#e9d5ff"
  purple-1000: "#f3e8ff"

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
    backgroundColor: "{colors.background-200}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
    borderColor: "{colors.gray-alpha-400}"
  button-tertiary:
    backgroundColor: transparent
    textColor: "{colors.gray-800}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
  button-error:
    backgroundColor: "{colors.red-600}"
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
    backgroundColor: "{colors.background-200}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.label-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 32px
    borderColor: "{colors.gray-alpha-400}"
  input-mono:
    backgroundColor: "{colors.background-200}"
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
    backgroundColor: "{colors.background-200}"
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
    textColor: "{colors.gray-700}"
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
    backgroundColor: "#050506"
    textColor: "{colors.green-700}"
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

# RE-E Design — Dark Theme

The primary consumption target. Same token names and semantics as `DESIGN.md`; only
values differ. All usage rules, component state rules, motion, shapes, voice, and
do/don'ts are defined there — this file intentionally does not repeat them.

## Dark-specific deltas

- **Elevation:** borders carry hierarchy; shadows are near-invisible on dark:
  Popover/Drawer `0 0 0 1px {colors.gray-alpha-300}, 0 8px 24px rgba(0,0,0,0.5)`;
  Modal `0 0 0 1px {colors.gray-alpha-400}, 0 24px 48px rgba(0,0,0,0.6)`.
- **Solid fills invert intent:** `gray-700` is a *light* fill (high contrast on dark),
  `gray-1000` near-white — primary button is light-on-dark, not dark-on-dark.
- **Log line** strip darkens to `#050506`; level colors brighten one step (LOG
  `green-700`, INFO `blue-700`, WARN `amber-700`, ERROR `red-700`, DEBUG `purple-700`).
- **Accent `700` steps** are the bright, saturated end for dark contrast; `100–300`
  are deep tints used as quiet backgrounds (nav active, badge fills).
- **Focus ring** outer gap color follows `background-100` (near-black).
