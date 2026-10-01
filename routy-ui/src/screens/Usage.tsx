import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDetails, useDetailsForEvent, useGateway, useHistory, useNodes, useStats } from "../api/hooks";
import type { RequestDetail, UsageHistoryRow } from "../api/types";
import { fmtAgo, fmtClock, fmtCost, fmtMs, fmtTokens } from "../utils/format";
import { Card } from "../components/ui/Card";
import { Drawer } from "../components/ui/Drawer";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { Tabs } from "../components/ui/Tabs";
import { CopyChip } from "../components/CopyChip";
import { StatTile } from "../components/StatTile";
import { ChartBar, XCircle } from "../components/icons";
import { cn } from "../utils/cn";

/* ── shared bits ───────────────────────────────────────────────────────────── */
const TOTAL_TOKENS = (r: UsageHistoryRow) => (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);


/** Pretty JSON with a copy affordance; falls back to raw text when unparseable. */
function JsonBlock({ text, truncated }: { text: string; truncated?: boolean }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }, [text]);

  return (
    <div className="flex flex-col gap-1.5">
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-border-subtle bg-bg p-3 font-mono text-xs leading-relaxed text-text-main custom-scrollbar md:text-[11px]">
        {pretty}
      </pre>
      {truncated && <p className="text-xs text-warning md:text-[10px]">payload truncated by the backend size cap</p>}
    </div>
  );
}

/* ── Overview tab ──────────────────────────────────────────────────────────── */
function OverviewTab({ rows, since, range }: { rows: UsageHistoryRow[]; since: number; range: string }) {
  const stats = useStats(since);
  const [metric, setMetric] = useState("tokens");

  // The chart answers the SAME range as everything else on this tab — the complaint it fixes was
  // literal: switching 24h → 30D left an identical curve on screen, because the buckets were
  // hardcoded to the last 24 hours. Hourly for the two 24-hour-scale presets, daily beyond
  // (hourly over 30 days is a smear nobody can read), and `all` starts at the oldest row rather
  // than at epoch — thousands of empty days would be a chart of nothing.
  const hourlyRange = range === "today" || range === "24h";
  const series = useMemo(() => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const STEP = hourlyRange ? HOUR : DAY;
    const floorTo = (t: number) => {
      const d = new Date(t);
      if (hourlyRange) d.setMinutes(0, 0, 0);
      else d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const agg: Record<number, { tokens: number; cost: number; requests: number }> = {};
    for (const r of rows) {
      const ts = floorTo(r.ts);
      const b = agg[ts] ?? { tokens: 0, cost: 0, requests: 0 };
      b.tokens += TOTAL_TOKENS(r);
      b.cost += r.cost_usd ?? 0;
      b.requests += 1;
      agg[ts] = b;
    }
    const first =
      range === "all"
        ? rows.length ? floorTo(Math.min(...rows.map((r) => r.ts))) : floorTo(Date.now())
        : floorTo(since);
    const last = floorTo(Date.now());
    const buckets: { label: string; tokens: number; cost: number; requests: number }[] = [];
    for (let t = first; t <= last; t += STEP) {
      const b = agg[t] ?? { tokens: 0, cost: 0, requests: 0 };
      const d = new Date(t);
      buckets.push({
        label: hourlyRange
          ? d.getHours().toString().padStart(2, "0")
          : `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`,
        tokens: b.tokens,
        cost: Math.round(b.cost * 10000) / 10000,
        requests: b.requests,
      });
    }
    return buckets;
  }, [rows, range, since, hourlyRange]);

  const s = stats.data;
  const hasTraffic = rows.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 sm:gap-4">
        {/* Every tile — requests included — aggregates over the SELECTED window and says which
            one; the dashboard home keeps its fixed "today / 7d" tiles, where those words are
            literally its window. */}
        <StatTile label={`Requests · ${RANGE_LABEL[range]}`} value={(s?.requests ?? 0).toLocaleString()} />
        <StatTile label={`Tokens · ${RANGE_LABEL[range]}`} value={fmtTokens(s?.tokens7d ?? 0)} />
        <StatTile label={`Cost · ${RANGE_LABEL[range]}`} value={fmtCost(s?.costUsd7d ?? 0)} />
        <StatTile label={`Error rate · ${RANGE_LABEL[range]}`} value={`${(s?.errorRatePct ?? 0).toFixed(1)}%`} />
        <StatTile label={`TTFT · p50 · ${RANGE_LABEL[range]}`} value={s && s.ttftP50Ms > 0 ? `${s.ttftP50Ms}ms` : "—"} sub={s?.ttftP50Ms ? undefined : "no successful probe yet"} />
      </div>

      <Card padding="sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <ChartBar size={16} className="text-text-muted" />
            <h3 className="truncate text-sm font-semibold text-text-main">{CHART_TITLE[range] ?? "Last 7 days"}</h3>
          </div>
          <Tabs
            size="sm"
            value={metric}
            onChange={setMetric}
            items={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "Cost" },
              { value: "requests", label: "Requests" },
            ]}
          />
        </div>

        {stats.isLoading ? (
          <Skeleton rows={4} />
        ) : !hasTraffic ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <p className="text-sm text-text-muted">No traffic yet.</p>
            <p className="text-xs text-text-subtle">
              Send a request through <span className="font-mono text-text-main">/v1/chat/completions</span> and this
              chart fills in.
            </p>
          </div>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="ree-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--color-text-muted)" }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    metric === "cost" ? `$${value}` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
                  }
                />
                <Tooltip
                  cursor={{ stroke: "var(--color-border)" }}
                  contentStyle={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: 10,
                    fontSize: 12,
                    color: "var(--color-text-main)",
                  }}
                  formatter={(value: unknown) => [
                    typeof value === "number"
                      ? metric === "cost"
                        ? `$${value.toFixed(4)}`
                        : value.toLocaleString()
                      : String(value),
                    metric,
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey={metric}
                  stroke="var(--color-primary)"
                  strokeWidth={1.5}
                  fill="url(#ree-area)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── Details tab ───────────────────────────────────────────────────────────── */
function DetailsTab({ rows }: { rows: UsageHistoryRow[] }) {
  const nodes = useNodes();
  const [open, setOpen] = useState<UsageHistoryRow | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const totalPages = Math.ceil(rows.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages - 1);
  const pagedRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const details = useDetails(200);
  const exact = useDetailsForEvent(open?.id ?? null);
  const nodeNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const n of nodes.data ?? []) map[n.id] = n.name;
    return map;
  }, [nodes.data]);

  /**
   * Round 2 gives details rows a `usageEventId`, so the pair is correlated exactly.
   * Rows written before that column carry null and still fall back to the
   * millisecond timestamp they were recorded in.
   */
  const detailsFor = (row: UsageHistoryRow | null): RequestDetail[] => {
    if (!row) return [];
    const byId = new Map<number, RequestDetail>();
    for (const d of [...(exact.data ?? []), ...(details.data ?? [])]) byId.set(d.id, d);
    const matched = [...byId.values()].filter((d) => d.usageEventId === row.id);
    if (matched.length) return matched.sort((a, b) => a.ts - b.ts);
    return [...byId.values()]
      .filter((d) => (d.usageEventId ?? null) === null && Math.abs(d.ts - row.ts) < 1500)
      .sort((a, b) => a.ts - b.ts);
  };

  return (
    <>
      <Card padding="none" className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <p className="text-sm text-text-muted">No requests recorded yet.</p>
            <p className="text-xs text-text-subtle">Request rows appear here as soon as the gateway serves traffic.</p>
          </div>
        ) : (
          <div className="w-full min-w-0 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-alt text-left">
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Time</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Model</th>
                  <th className="hidden px-4 py-2 text-xs font-medium text-text-muted md:table-cell">Node</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Status</th>
                  <th className="hidden px-4 py-2 text-right text-xs font-medium text-text-muted md:table-cell">Tokens</th>
                  <th className="hidden px-4 py-2 text-right text-xs font-medium text-text-muted md:table-cell">TTFT</th>
                  <th className="hidden px-4 py-2 text-right text-xs font-medium text-text-muted lg:table-cell">Duration</th>
                  <th className="hidden px-4 py-2 text-right text-xs font-medium text-text-muted xl:table-cell">Cost</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    onClick={() => setOpen(r)}
                    onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                    className="cursor-pointer border-t border-border-subtle transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60"
                  >
                    <td className="px-4 py-2 font-mono text-xs text-text-muted tabular">{fmtClock(r.at)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-text-main">{r.model ?? "—"}</td>
                    <td className="hidden px-4 py-2 text-xs text-text-muted md:table-cell">
                      {r.node_id ? nodeNameById[r.node_id] ?? "—" : "—"}
                    </td>
                    <td className="px-4 py-2">
                      {r.status === "ok" ? (
                        <Badge variant="success" size="sm">
                          ok
                        </Badge>
                      ) : (
                        <Badge variant="error" size="sm">
                          {r.error_code ?? r.status ?? "error"}
                        </Badge>
                      )}
                    </td>
                    <td className="hidden px-4 py-2 text-right font-mono text-xs text-text-main tabular md:table-cell">
                      {fmtTokens(TOTAL_TOKENS(r))}
                    </td>
                    <td className="hidden px-4 py-2 text-right font-mono text-xs text-text-muted tabular md:table-cell">
                      {fmtMs(r.ttft_ms)}
                    </td>
                    <td className="hidden px-4 py-2 text-right font-mono text-xs text-text-muted tabular lg:table-cell">
                      {fmtMs(r.duration_ms)}
                    </td>
                    <td className="hidden px-4 py-2 text-right font-mono text-xs text-text-muted tabular xl:table-cell">
                      {fmtCost(r.cost_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > PAGE_SIZE && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-bg-alt px-4 py-2 text-xs text-text-muted">
                <span>
                  Showing {safePage * PAGE_SIZE + 1}–{Math.min(rows.length, (safePage + 1) * PAGE_SIZE)} of {rows.length.toLocaleString()} requests
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={safePage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <span className="font-mono text-text-main">
                    {safePage + 1} / {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={safePage >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? `${open.model ?? "request"} · #${open.id}` : "request"}
        subtitle={
          open && (
            <span className="font-mono">
              {fmtClock(open.at)} · {fmtAgo(open.at)} · {open.status ?? "unknown"}
            </span>
          )
        }
        width={640}
      >
        {open && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                ["Prompt tokens", String(open.prompt_tokens ?? "—")],
                ["Completion tokens", String(open.completion_tokens ?? "—")],
                ["Cached tokens", String(open.cached_tokens ?? "—")],
                ["TTFT", fmtMs(open.ttft_ms)],
                ["Duration", fmtMs(open.duration_ms)],
                ["Cost", fmtCost(open.cost_usd)],
                ["Node", open.node_id ? nodeNameById[open.node_id] ?? open.node_id : "—"],
                ["Error", open.error_code ?? "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between rounded-[8px] bg-surface-2 px-3 py-2">
                  <span className="text-text-muted">{k}</span>
                  <span className="font-mono text-text-main tabular">{v}</span>
                </div>
              ))}
            </div>

            {details.data && details.data.length === 0 && (
              <p className="text-xs text-text-subtle">No stored payloads for this request.</p>
            )}
            {detailsFor(open).length === 0 && details.isLoading && <Skeleton rows={3} />}
            {detailsFor(open).map((d) => (
              <div key={d.id} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">{d.kind}</span>
                  <CopyChip value={`${d.kind} #${d.id}`} copyValue={d.content} label="copy" />
                </div>
                <JsonBlock text={d.content} truncated={d.truncated} />
              </div>
            ))}
          </div>
        )}
      </Drawer>
    </>
  );
}

/* ── Quota tab ─────────────────────────────────────────────────────────────── */
function QuotaTab({ rows, range }: { rows: UsageHistoryRow[]; range: string }) {
  const nodes = useNodes();
  const gateway = useGateway();

  const byNode = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const r of rows) {
      const key = r.node_id ?? "unknown";
      totals[key] = (totals[key] ?? 0) + TOTAL_TOKENS(r);
    }
    const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
    const nameById: Record<string, string> = {};
    for (const n of nodes.data ?? []) nameById[n.id] = n.name;
    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([id, tokens]) => ({ id, name: nameById[id] ?? id, tokens, pct: Math.round((tokens / grand) * 100) }));
  }, [rows, nodes.data]);

  const keyLine = gateway.data ? `${gateway.data.keyMasked}` : "—";

  return (
    <div className="flex flex-col gap-4">
      <Card padding="sm" className="flex flex-col gap-2">
        <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-main">Token share by node · {RANGE_LABEL[range] ?? "7D"}</h3>
            <p className="text-xs text-text-muted">
              Per-provider quota limits arrive with embedded providers — custom compatible nodes expose no quota API,
              so this is measured usage, not remaining allowance.
            </p>
          </div>
          <CopyChip className="shrink-0" value={keyLine} label="router key" />
        </div>

        {byNode.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <XCircle size={28} className="text-text-subtle" />
            <p className="text-sm text-text-muted">Nothing routed yet — no quota to show.</p>
            <p className="text-xs text-text-subtle">
              Mint a client key on <span className="text-text-main">Overview</span>, then send traffic.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 pt-1">
            {byNode.map((b) => (
              <div key={b.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-text-main">{b.name}</span>
                  <span className="font-mono text-text-muted tabular">
                    {fmtTokens(b.tokens)} · {b.pct}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                  <div
                    className={cn("h-full rounded-full transition-all duration-300")}
                    style={{ width: `${Math.max(b.pct, 1)}%`, background: "var(--color-primary)" }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── screen ────────────────────────────────────────────────────────────────── */
/** Date ranges, as the filter pill shows them. `7d` is the default — the window this screen
 *  always had, so existing ?tab= links keep their exact meaning. */
const RANGE_TABS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
];
const RANGE_LABEL: Record<string, string> = { today: "Today", "24h": "24h", "7d": "7D", "30d": "30D", "60d": "60D", all: "All" };

/** The chart draws exactly the selected range, so its title may never disagree with the pill. */
const CHART_TITLE: Record<string, string> = { today: "Today", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", "60d": "Last 60 days", all: "All time" };

/** Window start for a preset. Today is local midnight — a calendar fact, deliberately not
 *  "the last 12 hours"; everything else is rolling; `all` is 0, which the history route
 *  reads as no lower bound. Computed once per selection and pinned, so a page left open
 *  across midnight keeps the window it started with rather than silently growing. */
const rangeToSince = (range: string): number => {
  const now = Date.now();
  switch (range) {
    case "today": { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    case "24h": return now - 24 * 3600_000;
    case "30d": return now - 30 * 24 * 3600_000;
    case "60d": return now - 60 * 24 * 3600_000;
    case "all": return 0;
    default: return now - 7 * 24 * 3600_000;
  }
};

/** Row budget per preset: the detail rows the client fetches. `all` fetches everything
 *  (1e6 is the route's ceiling, not a display cut — it is never meant to be reached); the
 *  count line says "latest N" if any cap is actually hit, so a slice cannot read as a range. */
const RANGE_LIMIT: Record<string, number> = { today: 1000, "24h": 1000, "7d": 2000, "30d": 5000, "60d": 5000, all: 1_000_000 };

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "details", label: "Details" },
  { value: "quota", label: "Quota" },
];

export function Usage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? (params.get("tab") as string) : "overview";
  const range = RANGE_TABS.some((t) => t.value === params.get("range")) ? (params.get("range") as string) : "7d";
  const since = useMemo(() => rangeToSince(range), [range]);
  const limit = RANGE_LIMIT[range] ?? RANGE_LIMIT["7d"];
  const history = useHistory({ since, limit });
  // The window's rows, whole — no kind picker: usage is watched for the chat provider. The
  // `kind` column stays on every row, and scoping the TILES to chat as well would be a kind
  // param on /api/usage/stats; until then media requests still count in both.
  const rows = history.data ?? [];
  const gateway = useGateway();

  const setTab = (next: string) => {
    const sp = new URLSearchParams(params);
    sp.set("tab", next);
    setParams(sp, { replace: true });
  };

  // The range rides the URL like the tab does: reload and share keep the window.
  const setRange = (next: string) => {
    const sp = new URLSearchParams(params);
    sp.set("range", next);
    setParams(sp, { replace: true });
  };

  if (history.isError) {
    return (
      <Card className="flex flex-col items-center gap-3 py-16 text-center">
        <XCircle size={36} className="text-text-subtle" />
        <p className="text-sm text-text-muted">Usage unavailable — the gateway may be restarting.</p>
        <Button variant="secondary" onClick={() => history.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onChange={setTab} items={TABS} />
        {/* The endpoint is the thing a phone user most needs to read (and copy), so it
            wraps here rather than truncating with nothing to reveal the rest. */}
        <span className="min-w-0 break-all font-mono text-xs text-text-subtle sm:truncate md:text-[11px]" title={gateway.data?.endpoint ?? ""}>
          {gateway.data?.endpoint ?? ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-3">
        <Tabs size="sm" value={range} onChange={setRange} items={RANGE_TABS} />
        <span className="text-[11px] text-text-muted">
          {rows.length} requests · {RANGE_LABEL[range]}
          {/* The cap is a fact, not a detail: when the route's ceiling was actually hit, say
              so instead of letting a quiet slice read as the whole range. */}
          {rows.length >= limit ? ` · latest ${limit.toLocaleString()}` : ""}
        </span>
      </div>

      {tab === "overview" && <OverviewTab rows={rows} since={since} range={range} />}
      {tab === "details" && <DetailsTab rows={rows} />}
      {tab === "quota" && <QuotaTab rows={rows} range={range} />}
    </div>
  );
}
