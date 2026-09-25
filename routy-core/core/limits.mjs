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
