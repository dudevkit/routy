// routy node latency memory — EWMA of time-to-first-token per node.
//
// Kept in memory rather than read from usage_events per request: routing needs a
// cheap synchronous answer on the hot path. Seeded from recent history at boot so
// a restart does not throw away what the last hour already learned.
const ALPHA = 0.3;
const ewma = new Map(); // nodeId -> ms

export function observeTtft(nodeId, ms) {
  if (!nodeId || !Number.isFinite(ms) || ms < 0) return;
  const cur = ewma.get(nodeId);
  ewma.set(nodeId, cur === undefined ? ms : cur + ALPHA * (ms - cur));
}

export function ttftOf(nodeId) {
  const v = ewma.get(nodeId);
  return v === undefined ? null : v;
}

/** Seed (or overwrite) from an average — used once at boot. */
export function seedTtft(nodeId, ms) {
  if (!nodeId || !Number.isFinite(ms) || ms < 0) return;
  ewma.set(nodeId, ms);
}

export function resetLatency() {
  ewma.clear();
}

export const latencySnapshot = () => Object.fromEntries([...ewma].map(([k, v]) => [k, Math.round(v)]));
