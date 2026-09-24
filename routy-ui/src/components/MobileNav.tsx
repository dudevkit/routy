import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { X } from "./icons";

/**
 * Mobile navigation.
 *
 * Below `lg` the desktop rail is display:none, and until now nothing replaced it: on a
 * phone the dashboard had no way to reach any screen other than the one you happened to
 * land on. This renders the very same <Sidebar /> behind a left slide-over rather than a
 * second nav model — there are ten destinations, which does not fit a bottom bar, and a
 * duplicated list is a list that goes stale the first time a route is added.
 */
export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div className="slide-in-left absolute inset-y-0 left-0 flex w-[86vw] max-w-72 flex-col border-r border-border-subtle bg-vibrancy shadow-[var(--shadow-elev)]">
        <div className="flex shrink-0 justify-end px-2 pt-2">
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="min-h-0 shrink-0 rounded-[10px] p-2.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <Sidebar />
        </div>
      </div>
    </div>
  );
}
