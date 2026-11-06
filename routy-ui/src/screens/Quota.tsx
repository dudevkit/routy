import { useState, useMemo } from "react";
import { useQuotaOverview, useRefreshQuota } from "../api/hooks";
import type { QuotaAccount } from "../api/types";
import { ProviderQuotaCard } from "../components/quota/ProviderQuotaCard";
import { Button } from "../components/ui/Button";
import { ArrowsClockwise, Spinner, Gauge } from "../components/icons";
import { toastApiError } from "../utils/errors";
import { useToast } from "../components/ui/Toast";
import { cn } from "../utils/cn";

export function Quota() {
  const { data, isLoading, refetch, isFetching } = useQuotaOverview();
  const refreshMutation = useRefreshQuota();
  const toast = useToast();
  const [selectedProvider, setSelectedProvider] = useState<string>("all");

  const providers = data?.providers || [];

  // Flatten accounts with their parent provider info
  const allAccounts = useMemo(() => {
    const list: Array<{ providerId: string; providerName: string; account: QuotaAccount }> = [];
    for (const p of providers) {
      for (const acc of p.accounts || []) {
        list.push({ providerId: p.id, providerName: p.name, account: acc });
      }
    }
    return list;
  }, [providers]);

  const filteredAccounts = useMemo(() => {
    if (selectedProvider === "all") return allAccounts;
    return allAccounts.filter((item) => item.providerId === selectedProvider);
  }, [allAccounts, selectedProvider]);

  const handleRefreshSingle = async (connectionId: string, provider: string) => {
    try {
      await refreshMutation.mutateAsync({ connectionId, provider });
      toast("Successfully updated quota snapshot.", "success");
    } catch (err) {
      toastApiError(toast, err, "Failed to refresh quota");
    }
  };

  const handleRefreshAll = async () => {
    try {
      for (const item of filteredAccounts) {
        await refreshMutation.mutateAsync({
          connectionId: item.account.connectionId,
          provider: item.providerId,
        });
      }
      await refetch();
      toast("Upstream quotas successfully updated.", "success");
    } catch (err) {
      toastApiError(toast, err, "Failed to refresh all quotas");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner / Heading */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border-subtle pb-5">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
            <Gauge size={24} weight="duotone" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-main">
              Quota Tracker
            </h1>
            <p className="text-xs sm:text-sm text-text-muted">
              Live capacity and window headroom for trackable upstream accounts.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshAll}
            disabled={refreshMutation.isPending || isFetching || allAccounts.length === 0}
            className="flex items-center gap-2 font-medium"
          >
            {refreshMutation.isPending || isFetching ? <Spinner size={16} /> : <ArrowsClockwise size={16} />}
            <span>Refresh All</span>
          </Button>
        </div>
      </div>

      {/* Provider Filter Tabs */}
      {providers.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-border-subtle/60 custom-scrollbar">
          <button
            type="button"
            onClick={() => setSelectedProvider("all")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0",
              selectedProvider === "all"
                ? "bg-primary text-white"
                : "text-text-muted hover:text-text-main hover:bg-surface-subtle"
            )}
          >
            All Accounts ({allAccounts.length})
          </button>
          {providers.map((p) => {
            const count = p.accounts?.length || 0;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedProvider(p.id)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0",
                  selectedProvider === p.id
                    ? "bg-primary text-white"
                    : "text-text-muted hover:text-text-main hover:bg-surface-subtle"
                )}
              >
                {p.name} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Content Cards */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Spinner size={24} className="text-primary" />
          <span className="text-xs text-text-muted font-mono">Loading quota tracking accounts…</span>
        </div>
      ) : filteredAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-subtle p-12 text-center bg-surface/40">
          <div className="flex size-12 items-center justify-center rounded-xl bg-surface-subtle text-text-muted mb-3">
            <Gauge size={24} />
          </div>
          <h3 className="text-base font-semibold text-text-main">No Trackable Accounts Found</h3>
          <p className="mt-1 max-w-sm text-xs text-text-muted">
            Connect an Antigravity Google account or WorkBuddy account from the Providers menu to start tracking quotas.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {filteredAccounts.map(({ providerId, providerName, account }) => (
            <ProviderQuotaCard
              key={account.connectionId}
              providerId={providerId}
              providerName={providerName}
              account={account}
              onRefresh={handleRefreshSingle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
