import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";

type Variant = "primary" | "secondary" | "tertiary" | "error";

const variantClasses: Record<Variant, string> = {
  primary: "bg-gray-1000 text-background-100 hover:bg-gray-900 active:bg-gray-800",
  secondary:
    "border border-gray-alpha-400 bg-background-200 text-gray-1000 hover:border-gray-alpha-500 hover:bg-background-300 active:border-gray-alpha-600",
  tertiary: "bg-transparent text-gray-800 hover:bg-gray-alpha-200 active:bg-gray-alpha-300",
  error: "bg-red-600 text-white hover:bg-red-500 active:bg-red-600",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm";
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size, icon, className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm font-medium transition-colors duration-150 focus-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-[26px] px-2 text-13" : "h-8 px-2.5 text-14",
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
