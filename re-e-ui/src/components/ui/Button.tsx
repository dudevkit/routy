import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";
import { Spinner } from "../icons";

const variants = {
  primary: "bg-primary hover:bg-primary-hover text-white shadow-sm disabled:bg-surface-3 disabled:text-text-muted",
  secondary: "bg-surface-2 hover:bg-surface-3 text-text-main border border-border disabled:opacity-50",
  outline: "border border-border text-text-main hover:bg-surface-2 hover:border-brand-500/40",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text-main",
  danger: "bg-danger hover:brightness-90 text-white shadow-sm disabled:bg-surface-3 disabled:text-text-muted",
  success: "bg-success hover:brightness-90 text-white shadow-sm disabled:bg-surface-3 disabled:text-text-muted",
};

const sizes = {
  sm: "h-7 px-3 text-xs rounded-[8px]",
  md: "h-9 px-4 text-sm rounded-[10px]",
  lg: "h-11 px-6 text-sm rounded-[10px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 ease-out cursor-pointer",
        "active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        sizes[size],
        fullWidth && "w-full",
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children}
      {iconRight && !loading && iconRight}
    </button>
  );
}
