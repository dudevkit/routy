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

/** §7 taxonomy + management-plane codes: machine tokens, never user copy. */
const CODES = new Set([
  "auth_error",
  "rate_limited",
  "upstream_error",
  "network_error",
  "all_unavailable",
  "not_found",
  "bad_request",
  "conflict",
  "internal_error",
]);

/** Fallback wording for a code that arrives without a detail. */
const CODE_COPY: Record<string, string> = {
  auth_error: "This client key is not valid",
  rate_limited: "Upstream is rate limiting — retry shortly",
  upstream_error: "Upstream returned an error",
  network_error: "Upstream is unreachable",
  all_unavailable: "Every route is unavailable — breakers open",
  not_found: "That record no longer exists — refresh",
  bad_request: "The gateway rejected this request",
  conflict: "That value is already taken",
  internal_error: "Gateway error — see Live Console for the line",
};

/**
 * One place to turn a transport failure into the Voice & Content rule: what
 * happened, in human terms. Round 3 returns `409 {message:"conflict", detail:
 * 'prefix "x" is already in use'}` — when the code adds nothing to the detail,
 * lead with the detail. Probes are excluded: they answer 200 + `ok:false` and
 * are handled as results, not errors.
 */
export function toastApiError(toast: ToastPush, err: unknown, fallbackMessage: string): void {
  if (err instanceof ApiRequestError) {
    const code = err.message.trim();
    const text = err.detail
      ? CODES.has(code)
        ? err.detail
        : `${code} · ${err.detail}`
      : CODE_COPY[code] ?? code;
    const friendly = humanize(text);
    if (friendly !== text) console.warn("[re-e-ui] backend error:", text);
    toast(friendly || fallbackMessage, "error");
    return;
  }
  const message = err instanceof Error ? err.message : "";
  toast(humanize(message) || fallbackMessage, "error");
}
