import { cn } from "../../utils/cn";

interface QuotaProgressBarProps {
  remainingPercentage: number;
  className?: string;
  height?: "sm" | "md" | "lg";
  showLabel?: boolean;
}

export function QuotaProgressBar({
  remainingPercentage,
  className,
  height = "md",
  showLabel = false,
}: QuotaProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(remainingPercentage)));

  const colorClasses =
    clamped > 70
      ? { bar: "bg-emerald-500", text: "text-emerald-500", track: "bg-emerald-500/10" }
      : clamped >= 30
        ? { bar: "bg-amber-500", text: "text-amber-500", track: "bg-amber-500/10" }
        : { bar: "bg-rose-500", text: "text-rose-500", track: "bg-rose-500/10" };

  const hClass = height === "sm" ? "h-1.5" : height === "lg" ? "h-3" : "h-2";

  return (
    <div className={cn("w-full flex flex-col gap-1.5", className)}>
      <div className={cn("w-full rounded-full overflow-hidden relative", hClass, colorClasses.track)}>
        <div
          className={cn("h-full rounded-full transition-all duration-300 ease-out", colorClasses.bar)}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showLabel && (
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-text-muted">Remaining</span>
          <span className={cn("font-medium", colorClasses.text)}>{clamped}%</span>
        </div>
      )}
    </div>
  );
}
