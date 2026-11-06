import { useState } from "react";
import type { QuotaAccount } from "../../api/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ArrowsClockwise, Spinner } from "../icons";
import { QuotaProgressBar } from "./QuotaProgressBar";
import { QuotaTable } from "./QuotaTable";

interface ProviderQuotaCardProps {
  providerId: string;
  providerName: string;
  account: QuotaAccount;
  onRefresh: (connectionId: string, provider: string) => Promise<void>;
}

export function ProviderQuotaCard({
  providerId,
  providerName,
  account,
  onRefresh,
}: ProviderQuotaCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh(account.connectionId, providerId);
    } finally {
      setRefreshing(false);
    }
  };

  // Compute aggregate percentage if any
  const quotaEntries = Object.entries(account.quotas || {});
  const avgRemaining =
    quotaEntries.length > 0
      ? Math.round(
          quotaEntries.reduce((acc, [, q]) => acc + (q.remainingPercentage || 0), 0) /
            quotaEntries.length
        )
      : null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-5 transition-shadow hover:shadow-md">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-subtle font-mono text-sm font-semibold text-primary">
            {providerName.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold text-text-main">
                {account.accountLabel || providerName}
              </h3>
              <Badge variant="primary" size="sm" className="font-mono text-[11px]">
                {account.plan}
              </Badge>
            </div>
            <span className="truncate text-xs text-text-muted font-mono">
              prefix: {account.nodePrefix} · ID: {account.connectionId.slice(0, 8)}…
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-main"
            title="Refresh quota from upstream"
          >
            {refreshing ? <Spinner size={14} /> : <ArrowsClockwise size={14} />}
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* Aggregate Overview Bar if models exist */}
      {avgRemaining !== null && (
        <div className="rounded-lg border border-border-subtle/80 bg-surface-subtle/30 p-3">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-medium text-text-muted">Average Quota Headroom</span>
            <span className="font-mono font-semibold text-text-main">{avgRemaining}%</span>
          </div>
          <QuotaProgressBar remainingPercentage={avgRemaining} height="sm" />
        </div>
      )}

      {/* Details Table */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-xs font-medium text-text-muted hover:text-text-main transition-colors flex items-center gap-1"
          >
            <span>{expanded ? "Hide" : "Show"} Model Quota Breakdown</span>
            <span className="text-[10px]">{expanded ? "▲" : "▼"}</span>
          </button>
          {account.fetchedAt && (
            <span className="text-[11px] font-mono text-text-muted">
              Updated {new Date(account.fetchedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        {expanded && <QuotaTable quotas={account.quotas} />}
      </div>

      {account.error && (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-500 font-mono">
          {account.error}
        </div>
      )}
    </div>
  );
}
