/**
 * Sanitize a free-text upstream message destined for a log line, a stored hit, or the caller's
 * `detail`. A provider's error body is the diagnosis and is worth keeping; it is also the one
 * place a credential can arrive as prose, so the shapes that carry one are replaced first and
 * the result is bounded. Not a substitute for masking a known secret (see `db/repos.mjs` for
 * that pass) — this is the one that runs when no secret list is available.
 */
export function redactUpstreamText(value, { max = 500 } = {}) {
  const text = String(value ?? "");
  if (!text) return "";
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
    .replace(/\bBearer\s+[^\s,;"'}]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|pk|rk|api)[-_][a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/(["']?(?:authorization|proxy-authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;&}\]]+)/gi, "$1[REDACTED]")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .slice(0, max);
}

// Credential masking for logs and UI: enough to tell two keys apart, never enough to
// leak one. Shared because three call sites had grown three slightly different copies.
export const maskKey = (k) => (typeof k === "string" && k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? "•••" : "—");
