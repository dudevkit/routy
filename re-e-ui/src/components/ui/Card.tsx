import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-lg border border-gray-alpha-300 bg-background-200", className)}>
      {children}
    </div>
  );
}
