import type { InputHTMLAttributes } from "react";
import { cn } from "../../utils/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Mono variant — baseUrl, keys, prefixes, model ids */
  mono?: boolean;
}

export function Input({ mono, className, ...rest }: InputProps) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-sm border border-gray-alpha-400 bg-background-200 px-2.5 text-gray-1000 transition-colors duration-150",
        "placeholder:text-gray-600 hover:border-gray-alpha-500 focus:border-gray-alpha-500 focus-ring",
        mono ? "font-mono text-12" : "text-14",
        className,
      )}
      {...rest}
    />
  );
}
