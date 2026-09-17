import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { StatusDot } from "./StatusDot";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, kind: ToastKind = "success") => {
    nextId += 1;
    const id = nextId;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="re-modal-in flex items-center gap-2 rounded-md border border-gray-alpha-400 bg-background-300 px-3 py-2 text-13 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          >
            <StatusDot tone={t.kind === "success" ? "green" : t.kind === "error" ? "red" : "blue"} />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
