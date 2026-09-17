import { cn } from "../../utils/cn";

type Tone = "green" | "amber" | "red" | "gray" | "blue";

const toneClasses: Record<Tone, string> = {
  green: "bg-green-600",
  amber: "bg-amber-600",
  red: "bg-red-600",
  gray: "bg-gray-500",
  blue: "bg-blue-600",
};

/**
 * Status dot. `pulse` is reserved for the gateway live indicator — the only
 * looping animation in the system (DESIGN.md Motion section).
 */
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
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-50", toneClasses[tone])} />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", toneClasses[tone])} />
    </span>
  );
}
