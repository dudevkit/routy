import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

const variants = {
  default: "bg-surface-2 text-text-muted",
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  error: "bg-danger/10 text-danger",
  info: "bg-info/10 text-info",
};
const sizes = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2.5 py-1 text-xs",
  lg: "px-3 py-1.5 text-sm",
};

const dotColors: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-danger",
  info: "bg-info",
  primary: "bg-primary",
  default: "bg-gray-500",
};

export function Badge({
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
  children,
}: {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  dot?: boolean;
  /** Material Symbol ligature name */
  icon?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-semibold",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", dotColors[variant])} />}
      {icon && <span className="material-symbols-outlined text-[14px]">{icon}</span>}
      {children}
    </span>
  );
}
