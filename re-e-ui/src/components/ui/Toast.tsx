import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle, Info, Warning, XCircle } from "../icons";

type ToastType = "success" | "error" | "warning" | "info";

/** Signature of the push function handed out by useToast(). */
export type ToastPush = (message: string, type?: ToastType) => void;

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

const toastStyles: Record<ToastType, { wrapper: string; icon: ReactNode }> = {
  success: {
    wrapper: "border-success/30 bg-success/10 text-success",
    icon: <CheckCircle size={18} weight="fill" className="shrink-0" />,
  },
  error: {
    wrapper: "border-danger/30 bg-danger/10 text-danger",
    icon: <XCircle size={18} weight="fill" className="shrink-0" />,
  },
  warning: {
    wrapper: "border-warning/30 bg-warning/10 text-warning",
    icon: <Warning size={18} weight="fill" className="shrink-0" />,
  },
  info: {
    wrapper: "border-info/30 bg-info/10 text-info",
    icon: <Info size={18} weight="fill" className="shrink-0" />,
  },
};

const ToastContext = createContext<ToastPush>(() => {});

export function useToast(): ToastPush {
  return useContext(ToastContext);
}

let nextId = 0;

/** Upstream DashboardLayout toast stack (fixed top-right) with Phosphor icons. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback<ToastPush>((message, type = "success") => {
    nextId += 1;
    const id = nextId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`fade-in rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${toastStyles[t.type].wrapper}`}
          >
            <div className="flex items-start gap-2">
              {toastStyles[t.type].icon}
              <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap break-words text-text-main">{t.message}</p>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
