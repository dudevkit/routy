import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "../icons";
import { cn } from "../../utils/cn";

/**
 * Right-side detail panel — the drill-down surface for Usage Details and log
 * lines. Same chrome as Modal (surface, hairlines, no window dots).
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={title}
        style={{ width: `min(${width}px, 94vw)` }}
        className={cn(
          "absolute inset-y-0 right-0 flex flex-col bg-surface border-l border-border-subtle",
          "shadow-[var(--shadow-elev)] slide-in-right",
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-main">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-text-muted">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-[8px] p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}
