// Shared operational constants. Node-breaker values live here rather than in
// handlers/chat.mjs so the per-connection health module can sit beside them without a
// circular import through the handler.
export const FAILURE_THRESHOLD = 3;      // consecutive failures that open a node breaker
export const OPEN_MS = 60_000;           // first breaker-open window
export const MAX_OPEN_MS = 30 * 60_000;  // breaker backoff cap

// Per-connection (API key) health. A cooldown starts at CONNECTION_COOLDOWN_MS and
// doubles per repeat up to the cap; a disable needs CONNECTION_STRIKES_TO_DISABLE
// hard failures within CONNECTION_STRIKE_WINDOW_MS.
export const CONNECTION_COOLDOWN_MS = 5 * 60_000;
export const CONNECTION_COOLDOWN_MAX_MS = 60 * 60_000;
export const CONNECTION_STRIKES_TO_DISABLE = 2;
export const CONNECTION_STRIKE_WINDOW_MS = 60 * 60_000;

export const STREAM_IDLE_TIMEOUT_MS = 120_000;

// Proxy exits (one URL each). Rotation spreads requests across them to multiply
// whatever the upstream meters per address, so an exit that fails or is rate-limited
// has to leave the rotation for a while — otherwise every N-th request is spent on a
// known-bad address and the fleet's capacity silently shrinks.
//
// The base is a MINUTE, not the five the key cooldown uses: the only reason to rotate
// proxied exits is a per-IP limit, and those are overwhelmingly per-minute. An explicit
// Retry-After still overrides it, which is the case that matters for per-day quotas.
export const PROXY_COOLDOWN_MS = 60_000;
export const PROXY_COOLDOWN_MAX_MS = 15 * 60_000;

// How many exits one request may try. Connect-level failures and 407s walk the list
// (they are fast and unambiguous), but capped: past a handful, the remaining exits are
// almost certainly the same kind of dead. Rate-limit failures get their own, smaller
// cap — a 429 that answers from several exits is a provider-wide limit that rotating
// will not fix, and walking fifty exits to learn that costs fifty requests.
export const PROXY_MAX_ATTEMPTS = 5;
export const PROXY_MAX_RATE_LIMIT_ATTEMPTS = 3;
