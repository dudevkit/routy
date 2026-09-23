import { cn } from "../../utils/cn";

type Tone = "green" | "yellow" | "red" | "gray" | "blue";

const toneClasses: Record<Tone, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-danger",
  gray: "bg-gray-500",
  blue: "bg-info",
};

/** Status dot; `pulse` reserved for live gateway indicators. */
export function StatusDot({
  tone,
  pulse,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && (
        <span className={cn("absolute inline-flex h-full w-full animate-pulse rounded-full opacity-75", toneClasses[tone])} />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", toneClasses[tone])} />
    </span>
  );
}
