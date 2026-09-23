// RE-E upstream connection pools — one tuned undici Agent per upstream origin.
//
// Why this exists: Node's built-in fetch runs on Node's *bundled* undici, whose
// dispatcher cannot be configured from the outside (a v8 Agent from the npm
// package is rejected with UND_ERR_INVALID_ARG), and whose default dispatcher
// re-establishes connections far too eagerly — measured 15.6ms p50 per loopback
// request through the gateway vs 0.4ms with a pooled Agent, a flat ~15ms that
// also dominated TTFT (P1's "≤5ms overhead" target).
//
// The npm undici fetch is a spec Response and accepts `dispatcher`, so it is a
// drop-in replacement for global fetch once a pool is attached.
import { Agent, fetch as undiciFetch } from "undici";

export const DEFAULT_POOL = Object.freeze({
  // Generous: a queued request is added latency, and this is a local gateway.
  // Bounded rather than unlimited so one origin cannot exhaust the process.
  connections: 64,
  pipelining: 1,
  keepAliveTimeoutMs: 60_000,
  keepAliveMaxTimeoutMs: 600_000,
  noDelay: true,
});

// Bounded so a fleet of ephemeral baseUrls cannot grow the map without limit.
const MAX_POOLS = 64;

/** origin -> { agent, key } — key is the resolved pool config, so a node whose
 *  pool settings changed gets a fresh agent instead of silently keeping the old. */
const pools = new Map();

export function originOf(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function resolvePoolConfig(node) {
  return { ...DEFAULT_POOL, ...(node?.data?.pool || {}) };
}

/**
 * The Agent for a node's upstream origin (null when the baseUrl is unusable).
 * One pool per origin: two nodes pointing at the same host share its sockets.
 */
export function getDispatcher(node) {
  const origin = originOf(node?.baseUrl);
  if (!origin) return null;
  const cfg = resolvePoolConfig(node);
  const key = JSON.stringify(cfg);

  const hit = pools.get(origin);
  if (hit && hit.key === key) return hit.agent;
  if (hit) {
    try { hit.agent.destroy(); } catch { /* already gone */ }
    pools.delete(origin);
  }
  if (pools.size >= MAX_POOLS) {
    const oldest = pools.keys().next().value;
    try { pools.get(oldest)?.agent.destroy(); } catch { /* already gone */ }
    pools.delete(oldest);
  }

  const agent = new Agent({
    connections: cfg.connections,
    pipelining: cfg.pipelining,
    keepAliveTimeout: cfg.keepAliveTimeoutMs,
    keepAliveMaxTimeout: cfg.keepAliveMaxTimeoutMs,
    connect: { noDelay: cfg.noDelay },
  });
  pools.set(origin, { agent, key });
  return agent;
}

/** Graceful close (waits for in-flight requests) — call after a drain, not during. */
export async function closePools() {
  const all = [...pools.values()];
  pools.clear();
  await Promise.allSettled(all.map((p) => p.agent.close()));
}

export const poolOrigins = () => [...pools.keys()];
export { undiciFetch };
