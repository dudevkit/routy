import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

type Variant = "success" | "warning" | "error" | "neutral";

const variantClasses: Record<Variant, string> = {
  success: "bg-green-100 text-green-800",
  warning: "bg-amber-100 text-amber-900",
  error: "bg-red-100 text-red-800",
  neutral: "bg-gray-alpha-200 text-gray-700",
};

export function Badge({
  variant = "neutral",
  className,
  children,
}: {
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-px font-mono text-11",
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
