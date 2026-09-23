import { useGateway, useHealth, usePutSettings, useSettings, useStats } from "../api/hooks";
import { toastApiError } from "../utils/errors";
import { fmtCost } from "../utils/format";
import { CopyChip } from "../components/CopyChip";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";
import { ThemeToggle } from "../components/ui/ThemeToggle";
import { Toggle } from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

function fmtUptime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Metered spend against the daily ceiling. Enforcement lives in the gateway, so
 * this card only mirrors it — today's spend comes from the same counter the
 * router blocks on, which keeps the two from disagreeing.
 */
function SpendCard() {
  const toast = useToast();
  const settings = useSettings();
  const stats = useStats();
  const put = usePutSettings();

  const limit = Number(settings.data?.budgetUsdPerDay) || 0;
  const spent = stats.data?.costUsdToday ?? 0;
  const over = limit > 0 && spent >= limit;
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;

  const commit = (raw: string) => {
    const value = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value === limit) return;
    put.mutate(
      { budgetUsdPerDay: value },
      {
        onSuccess: () => toast(value > 0 ? `Daily budget set to $${value}` : "Daily budget removed — unmetered"),
        onError: (err) => toastApiError(toast, err, "Failed to save budget"),
      },
    );
  };

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Spend</h3>
          <p className="text-[11px] text-text-muted">
            Metered spend since midnight. Upstreams with no price are unmetered, so they keep serving after the
            ceiling — add a price per node to include it.
          </p>
        </div>
        <Badge variant={over ? "error" : limit > 0 ? "success" : "default"} size="sm">
          {over ? "ceiling reached" : limit > 0 ? "within budget" : "unmetered"}
        </Badge>
      </div>

      <div className="flex flex-wrap items-end gap-5">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-text-muted">Spent today</span>
          <span className="font-mono text-sm text-text-main tabular">{fmtCost(spent)}</span>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-muted">Daily budget (USD)</span>
          <input
            key={limit}
            type="number"
            min={0}
            step="0.01"
            placeholder="unlimited"
            defaultValue={limit > 0 ? String(limit) : ""}
            disabled={put.isPending}
            onBlur={(e) => commit(e.target.value)}
            className="w-32 rounded-[6px] border border-border-subtle bg-bg px-2 py-1 font-mono text-xs text-text-main"
          />
        </label>
      </div>

      {limit > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
          <div className={over ? "h-full bg-danger" : "h-full bg-accent"} style={{ width: `${pct}%` }} />
        </div>
      )}
    </Card>
  );
}

export function Settings() {
  const toast = useToast();
  const gateway = useGateway();
  const health = useHealth();
  const settings = useSettings();
  const put = usePutSettings();

  const requireApiKey = settings.data?.requireApiKey === true;
  const setRequireApiKey = (enabled: boolean) =>
    put.mutate({ requireApiKey: enabled }, { onError: (err) => toastApiError(toast, err, "Failed to save setting") });

  return (
    <div className="flex flex-col gap-4">
      <Card padding="sm" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-text-main">Gateway</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Proxy endpoint</span>
            {gateway.data ? <CopyChip value={gateway.data.endpoint} /> : <Skeleton rows={1} />}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Router key</span>
            {gateway.data ? <CopyChip value={gateway.data.keyMasked} /> : <Skeleton rows={1} />}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Version · uptime</span>
            <span className="font-mono text-xs text-text-main tabular">
              {gateway.data?.version ?? "—"} · {health.data ? fmtUptime(health.data.uptimeMs) : "—"}
            </span>
          </div>
        </div>
      </Card>

      <Card padding="sm" className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-text-main">Access</h3>
        {settings.isLoading ? (
          <Skeleton rows={1} />
        ) : (
          <Toggle
            label="Require a client API key for /v1"
            hint={
              requireApiKey
                ? "Requests without a valid key get auth_error. This UI still works — it is same-origin on loopback."
                : "Open local gateway: any local client can route. Turn it on once you have minted keys."
            }
            checked={requireApiKey}
            loading={put.isPending}
            onChange={setRequireApiKey}
          />
        )}
      </Card>

      <SpendCard />

      <Card padding="sm" className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Appearance</h3>
          <p className="text-[11px] text-text-muted">Graphite Pro ships dark-first; light is the same tokens, retuned.</p>
        </div>
        <ThemeToggle variant="card" />
      </Card>
    </div>
  );
}
