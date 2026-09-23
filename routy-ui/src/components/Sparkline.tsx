import { cn } from "../utils/cn";
/**
 * Inline latency/volume sparkline — SVG only, no chart dep. The 8% accent area
 * fill reads as volume; the stroke stays the health signal (identity patch D5.3).
 */
export function Sparkline({
  data,
  w = 132,
  h = 36,
  area = true,
  className,
}: {
  data: number[];
  w?: number;
  h?: number;
  area?: boolean;
  className?: string;
}) {
  if (data.length < 2) {
    return (
      <div className={cn("flex items-center text-[10px] text-text-subtle", className)} style={{ width: w }}>
        no samples
      </div>
    );
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * (h - 6) - 3}`);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn("shrink-0", className)} aria-hidden="true">
      {area && <polygon points={`0,${h} ${points.join(" ")} ${w},${h}`} fill="var(--color-primary)" opacity="0.08" />}
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}
