/** Time/number formatting for live gateway data (ISO timestamps, ms, tokens). */

/** "2026-09-18T09:21:33.567Z" → "09:21:33" (local) */
export function fmtClock(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour12: false });
}

/** → "09:21:33.567" with milliseconds, for the log stream where ordering matters */
export function fmtClockMs(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** → "Sep 18, 09:21" */
export function fmtDateTime(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function fmtAgo(iso: string | number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** null/undefined stay distinguishable from 0 — the API means the difference */
export function fmtMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${ms}ms`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(usd: number | null): string {
  return usd === null ? "—" : `$${usd.toFixed(4)}`;
}
