import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  title?: string;
  message: string;
}

const toastStyles: Record<ToastType, { wrapper: string; icon: string }> = {
  success: { wrapper: "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400", icon: "check_circle" },
  error: { wrapper: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400", icon: "error" },
  warning: { wrapper: "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400", icon: "warning" },
  info: { wrapper: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400", icon: "info" },
};

const ToastContext = createContext<(message: string, type?: ToastType) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

/** Upstream DashboardLayout toast pattern: fixed top-right stack. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, type: ToastType = "success") => {
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
          <div key={t.id} className={`fade-in rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${toastStyles[t.type].wrapper}`}>
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] leading-5">{toastStyles[t.type].icon}</span>
              <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap break-words">{t.message}</p>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
