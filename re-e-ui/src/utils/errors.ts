import { ApiRequestError } from "../api/transport";
import type { ToastPush } from "../components/ui/Toast";

/**
 * One place to turn a transport failure into the Voice & Content rule: what
 * happened, plus the backend `detail`. Probes are excluded — they answer with
 * HTTP 200 + `ok:false` and are handled as results, not errors.
 */
export function toastApiError(toast: ToastPush, err: unknown, fallbackMessage: string): void {
  if (err instanceof ApiRequestError) {
    toast(err.detail ? `${err.message} · ${err.detail}` : err.message, "error");
    return;
  }
  const message = err instanceof Error ? err.message : "";
  toast(message || fallbackMessage, "error");
}
