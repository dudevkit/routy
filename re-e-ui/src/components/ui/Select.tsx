import type { SelectHTMLAttributes } from "react";
import { cn } from "../../utils/cn";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  label?: string;
  hint?: string;
  options: { value: string; label: string }[];
  className?: string;
}

/** Native select styled to match Input — the dark option list is themed in CSS. */
export function Select({ label, hint, options, className, ...rest }: SelectProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <span className="text-sm font-medium text-text-main">{label}</span>}
      <select
        className={cn(
          "h-9 w-full rounded-[10px] border border-transparent bg-surface-2 px-3 text-sm text-text-main",
          "focus:outline-none focus:ring-2 focus:ring-brand-500/30 transition-all duration-150",
          "disabled:opacity-50",
        )}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="text-xs text-text-muted">{hint}</span>}
    </div>
  );
}
