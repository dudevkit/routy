import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label?: string;
  error?: string;
  hint?: ReactNode;
  /** Material Symbol ligature name */
  icon?: string;
  mono?: boolean;
  className?: string;
  inputClassName?: string;
}

export function Input({
  label,
  error,
  hint,
  icon,
  mono,
  className,
  inputClassName,
  required,
  ...rest
}: InputProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-text-muted">
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
          </div>
        )}
        <input
          className={cn(
            "w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px]",
            "border border-transparent placeholder-text-muted/70",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
            "transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed",
            "text-[16px] sm:text-sm",
            icon && "pl-10",
            mono && "font-mono",
            error && "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500/40 border-red-500/40",
            inputClassName,
          )}
          {...rest}
        />
      </div>
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
