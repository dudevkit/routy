import { useMemo } from "react";
import type { ModelQuotaItem } from "../../api/types";
import { QuotaProgressBar } from "./QuotaProgressBar";
import { cn } from "../../utils/cn";

interface QuotaTableProps {
  quotas: Record<string, ModelQuotaItem>;
  className?: string;
}

function formatReset(resetAt: string | null): string {
  if (!resetAt) return "—";
  try {
    const d = new Date(resetAt);
    if (isNaN(d.getTime())) return "—";
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return "Reset imminent";

    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `in ${days}d (${timeStr})`;
    }
    if (hours > 0) {
      return `in ${hours}h ${mins}m (${timeStr})`;
    }
    return `in ${mins}m (${timeStr})`;
  } catch {
    return "—";
  }
}

export function QuotaTable({ quotas, className }: QuotaTableProps) {
  const items = useMemo(() => {
    return Object.entries(quotas).map(([key, val]) => ({
      key,
      name: val.displayName || key,
      remaining: Math.max(0, Math.min(100, Math.round(val.remainingPercentage ?? 0))),
      resetAt: val.resetAt,
      isWeekly: key.includes("weekly"),
    }));
  }, [quotas]);

  if (items.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-text-muted">
        No model quota breakdown reported yet.
      </div>
    );
  }

  return (
    <div className={cn("overflow-x-auto custom-scrollbar border border-border-subtle rounded-lg", className)}>
      <table className="w-full text-left text-xs border-collapse">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-subtle/50 text-text-muted uppercase tracking-wider font-mono text-[11px]">
            <th className="py-2.5 px-3 font-medium">Model / Window</th>
            <th className="py-2.5 px-3 font-medium w-48">Remaining</th>
            <th className="py-2.5 px-3 font-medium text-right">Reset Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle/60 font-mono">
          {items.map((item) => {
            const statusDot =
              item.remaining > 70
                ? "bg-emerald-500"
                : item.remaining >= 30
                  ? "bg-amber-500"
                  : "bg-rose-500";

            return (
              <tr key={item.key} className="hover:bg-surface-subtle/30 transition-colors">
                <td className="py-2.5 px-3 font-sans">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-2 rounded-full shrink-0", statusDot)} />
                    <span className={cn("font-medium", item.isWeekly ? "text-primary" : "text-text-main")}>
                      {item.name}
                    </span>
                    {item.isWeekly && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-primary/10 text-primary border border-primary/20">
                        Weekly
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-3">
                    <QuotaProgressBar remainingPercentage={item.remaining} height="sm" className="w-28" />
                    <span className="text-text-main font-medium w-9 text-right">{item.remaining}%</span>
                  </div>
                </td>
                <td className="py-2.5 px-3 text-right text-text-muted">
                  {formatReset(item.resetAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
