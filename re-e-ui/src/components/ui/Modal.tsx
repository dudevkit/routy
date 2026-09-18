import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "../icons";
import { cn } from "../../utils/cn";

const sizes = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  full: "max-w-4xl",
};

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  className,
}: {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof sizes;
  closeOnOverlay?: boolean;
  className?: string;
}) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in"
        onClick={closeOnOverlay ? onClose : undefined}
      />

      {/* Modal content — clean card with standard title + ghost X (no traffic lights) */}
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full bg-surface",
          "border border-border-subtle",
          "rounded-[14px] shadow-[var(--shadow-elev)]",
          "fade-in",
          sizes[size],
          className,
        )}
      >
        {/* Clean header */}
        {title && (
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
            <h2 className="text-base font-semibold text-text-main">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded-[8px] text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="p-6 max-h-[calc(85vh-100px)] overflow-y-auto custom-scrollbar">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle bg-bg-alt/40 rounded-b-[14px]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
