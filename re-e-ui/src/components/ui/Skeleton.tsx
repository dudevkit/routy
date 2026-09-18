import { cn } from "../../utils/cn";

/**
 * Initial-load shimmer. The live gateway answers in 5-50ms, so this only shows
 * on first paint / slow links — deliberately not used for refetches.
 */
export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn("h-3 animate-pulse rounded-[6px] bg-surface-2", i === rows - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}
