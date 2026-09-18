import { ApiRequestError } from "../api/transport";
import type { ToastPush } from "../components/ui/Toast";

/**
 * The gateway currently surfaces storage failures as `internal_error` with the raw
 * SQLite text (contract-requests round 3). Users should read intent, not schema:
 * map the known shapes, keep the raw string in the console for operators.
 */
const FRIENDLY: { pattern: RegExp; message: string }[] = [
  { pattern: /UNIQUE constraint failed: provider_nodes\.prefix/i, message: "That model prefix is already used by another upstream" },
  { pattern: /UNIQUE constraint failed: [^\s]+/i, message: "That value is already taken" },
  { pattern: /FOREIGN KEY constraint failed/i, message: "The record it points to is gone — refresh and try again" },
  { pattern: /database is locked|SQLITE_BUSY/i, message: "Gateway is mid-write — retry in a moment" },
  { pattern: /^internal_error$/i, message: "Gateway error — see Live Console for the line" },
];

function humanize(text: string): string {
  for (const rule of FRIENDLY) if (rule.pattern.test(text)) return rule.message;
  return text;
}

/**
 * One place to turn a transport failure into the Voice & Content rule: what
 * happened, plus the backend `detail`. Probes are excluded — they answer with
 * HTTP 200 + `ok:false` and are handled as results, not errors.
 */
export function toastApiError(toast: ToastPush, err: unknown, fallbackMessage: string): void {
  if (err instanceof ApiRequestError) {
    const raw = err.detail ? `${err.message} · ${err.detail}` : err.message;
    const friendly = humanize(raw);
    if (friendly !== raw) console.warn("[re-e-ui] backend error:", raw);
    toast(friendly, "error");
    return;
  }
  const message = err instanceof Error ? err.message : "";
  toast(humanize(message) || fallbackMessage, "error");
}
