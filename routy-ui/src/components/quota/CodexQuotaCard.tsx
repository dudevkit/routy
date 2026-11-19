import { useState } from "react";
import type { CodexQuotaWindow, CodexQuotaWindows, QuotaAccount } from "../../api/types";
import { ArrowsClockwise, Spinner } from "../icons";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { QuotaProgressBar } from "./QuotaProgressBar";

function resetLabel(value: string | null | undefined) {
  if (!value) return "Reset unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Reset unavailable" : `Resets ${date.toLocaleString()}`;
}

function WindowRow({ label, window }: { label: string; window: CodexQuotaWindow | null | undefined }) {
  const remaining = window?.remainingPercent;
  const known = typeof remaining === "number" && Number.isFinite(remaining);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-text-main">{label}</span>
        <span className="font-mono text-text-main">{known ? `${remaining}% remaining` : "Percentage unavailable"}</span>
      </div>
      {known && <QuotaProgressBar remainingPercentage={remaining} height="sm" />}
      <span className="text-xs text-text-muted">{resetLabel(window?.resetAt)}</span>
    </div>
  );
}

function Windows({ windows }: { windows?: CodexQuotaWindows }) {
  return <div className="flex flex-col gap-3">
    <WindowRow label="Session" window={windows?.primary} />
    <WindowRow label="Weekly" window={windows?.secondary} />
  </div>;
}

export function CodexQuotaCard({ account, onRefresh }: { account: QuotaAccount; onRefresh: (connectionId: string, provider: string) => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await onRefresh(account.connectionId, "codex"); } finally { setRefreshing(false); }
  };
  const error = typeof account.error === "string" ? account.error : account.error?.message;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-text-main">{account.accountLabel || "Codex account"}</h3>
            <Badge variant="primary" size="sm">{account.plan || "Plan unavailable"}</Badge>
            {account.stale && <Badge variant="default" size="sm">Stale</Badge>}
          </div>
          <p className="mt-1 text-xs text-text-muted">Codex · {account.nodePrefix} · {account.connectionStatus}{account.authState === "reauth-required" ? " · Reconnect required" : ""}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing} title="Refresh quota from upstream">
          {refreshing ? <Spinner size={14} /> : <ArrowsClockwise size={14} />} Refresh
        </Button>
      </div>
      <Windows windows={account.windows} />
      {account.additionalLimits?.map((limit, index) => (
        <section key={`${limit.meteredFeature || limit.name || "limit"}-${index}`} className="flex flex-col gap-3 border-t border-border-subtle pt-3">
          <h4 className="text-xs font-semibold text-text-main">{limit.name || limit.meteredFeature || "Additional limit"}</h4>
          <Windows windows={limit.windows} />
        </section>
      ))}
      {account.credits && <div className="border-t border-border-subtle pt-3 text-xs text-text-muted">
        Credits: {account.credits.unlimited ? "Unlimited" : account.credits.balance ?? (account.credits.hasCredits === false ? "None" : "Unavailable")}
        {account.credits.resetCreditsAvailableCount != null && <> · Reset credits available: {account.credits.resetCreditsAvailableCount}</>}
      </div>}
      {account.fetchedAt && <p className="text-xs text-text-muted">Updated {new Date(account.fetchedAt).toLocaleString()}</p>}
      {error && <p role="alert" className="rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-500">{error}</p>}
    </div>
  );
}
