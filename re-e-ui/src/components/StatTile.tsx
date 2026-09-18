import type { ReactNode } from "react";
import { Card } from "./ui/Card";
import { Skeleton } from "./ui/Skeleton";

/**
 * One metric per tile. The value uses the display face with tabular figures so
 * live counters don't jitter as digits change width (identity patch D5.5).
 */
export function StatTile({
  label,
  value,
  sub,
  loading,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  loading?: boolean;
}) {
  return (
    <Card padding="sm">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{label}</span>
        {loading ? (
          <Skeleton rows={1} />
        ) : (
          <span className="font-display text-xl font-semibold tracking-tight tabular">{value}</span>
        )}
        {sub && <span className="text-[10px] text-text-subtle">{sub}</span>}
      </div>
    </Card>
  );
}
