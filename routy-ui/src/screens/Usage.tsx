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
function OverviewTab({ rows }: { rows: UsageHistoryRow[] }) {
  const stats = useStats();
  const [metric, setMetric] = useState("tokens");

  const series = useMemo(() => {
    const hourly: Record<number, { tokens: number; cost: number; requests: number }> = {};
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const buckets: { label: string; tokens: number; cost: number; requests: number }[] = [];
    for (const r of rows) {
      const key = new Date(r.ts);
      key.setMinutes(0, 0, 0);
      const ts = key.getTime();
      hourly[ts] = hourly[ts] ?? { tokens: 0, cost: 0, requests: 0 };
      hourly[ts].tokens += TOTAL_TOKENS(r);
      hourly[ts].cost += r.cost_usd ?? 0;
      hourly[ts].requests += 1;
    }
    for (let i = 23; i >= 0; i--) {
      const ts = now.getTime() - i * 3600_000;
      const b = hourly[ts];
      buckets.push({
        label: new Date(ts).getHours().toString().padStart(2, "0"),
        tokens: b?.tokens ?? 0,
        cost: Math.round((b?.cost ?? 0) * 10000) / 10000,
        requests: b?.requests ?? 0,
      });
    }
    return buckets;
  }, [rows]);

  const s = stats.data;
  const hasTraffic = rows.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 sm:gap-4">
        <StatTile label="Requests · today" value={(s?.requestsToday ?? 0).toLocaleString()} />
        <StatTile label="Tokens · 7d" value={fmtTokens(s?.tokens7d ?? 0)} />
        <StatTile label="Cost · 7d" value={fmtCost(s?.costUsd7d ?? 0)} />
        <StatTile label="Error rate · 7d" value={`${(s?.errorRatePct ?? 0).toFixed(1)}%`} />
        <StatTile label="TTFT · p50" value={s && s.ttftP50Ms > 0 ? `${s.ttftP50Ms}ms` : "—"} sub={s?.ttftP50Ms ? undefined : "no successful probe yet"} />
      </div>

      <Card padding="sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <ChartBar size={16} className="text-text-muted" />
            <h3 className="truncate text-sm font-semibold text-text-main">Last 24 hours</h3>
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
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    onClick={() => setOpen(r)}
                    onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                    className="cursor-pointer border-t border-border-subtle transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
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
function QuotaTab({ rows }: { rows: UsageHistoryRow[] }) {
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
            <h3 className="text-sm font-semibold text-text-main">Token share by node · 7d</h3>
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
              Mint a client key in <span className="text-text-main">Settings</span>, then send traffic.
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
const TABS = [
  { value: "overview", label: "Overview" },
  { value: "details", label: "Details" },
  { value: "quota", label: "Quota" },
];

export function Usage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? (params.get("tab") as string) : "overview";
  const weekAgo = useMemo(() => Date.now() - 7 * 24 * 3600_000, []);
  const history = useHistory({ since: weekAgo, limit: 1000 });
  const gateway = useGateway();

  const setTab = (next: string) => {
    const sp = new URLSearchParams(params);
    sp.set("tab", next);
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

      {tab === "overview" && <OverviewTab rows={history.data ?? []} />}
      {tab === "details" && <DetailsTab rows={history.data ?? []} />}
      {tab === "quota" && <QuotaTab rows={history.data ?? []} />}
    </div>
  );
}
