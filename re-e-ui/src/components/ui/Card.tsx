import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";

const paddings = {
  none: "",
  xs: "p-3",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
  padding?: keyof typeof paddings;
  hover?: boolean;
  elev?: boolean;
}

export function Card({
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  elev = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        "bg-surface border border-border-subtle card-soft",
        elev && "rounded-[14px] shadow-[var(--shadow-elev)]",
        hover && "hover:shadow-[var(--shadow-warm)] hover:border-brand-500/30 transition-all cursor-pointer",
        paddings[padding],
        className,
      )}
      {...rest}
    >
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {icon && <div className="p-2 rounded-[10px] bg-bg text-text-muted">{icon}</div>}
            <div>
              {title && <h3 className="text-text-main font-semibold">{title}</h3>}
              {subtitle && <p className="text-sm text-text-muted">{subtitle}</p>}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
