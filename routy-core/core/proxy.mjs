// Outbound proxy support: pool resolution, rotation, and the dispatcher that actually
// sends requests through a proxy.
//
// Modelled on 9Router's design (open-sse/utils/proxyFetch.js + src/lib/network/
// connectionProxy.js) with two deliberate differences:
//
//   1. A pool holds ONE proxy URL. 9Router rotates across pools rather than across URLs
//      inside a pool, which is the only way per-proxy state (health, cooldown) can mean
//      anything — a pool with five URLs has nowhere to record which one failed.
//   2. `strict` defaults to TRUE. 9Router silently falls back to a direct request when
//      the proxy fails; for the reason people run a proxy here (the upstream rate-limits
//      or bans the caller's IP) a silent direct fallback leaks the real address and the
//      request looks like it succeeded. Opt out per pool, not in.
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { log } from "../lib/log.mjs";

// ProxyAgent owns its own connection pool to the proxy; the tuned per-origin Agent in
// executors/pool.mjs cannot be combined with it, so proxied requests trade the local
// connection reuse for the proxy's. Bounded so a fleet of pools cannot grow it forever.
const MAX_PROXY_AGENTS = 32;
const agents = new Map(); // proxyUrl -> ProxyAgent

/** The dispatcher for a proxy URL, cached per URL (credentials included in the key). */
export function getProxyAgent(proxyUrl) {
  const url = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  if (!url) return null;
  const hit = agents.get(url);
  if (hit) return hit;
  if (agents.size >= MAX_PROXY_AGENTS) {
    const oldest = agents.keys().next().value;
    try { agents.get(oldest)?.close?.(); } catch { /* already gone */ }
    agents.delete(oldest);
  }
  let agent;
  try {
    agent = new ProxyAgent({ uri: url });
  } catch (err) {
    // A malformed proxy URL must not take the gateway down: log and treat as no proxy,
    // which surfaces as the direct request the caller would have made anyway.
    log.warn("PROXY", `unusable proxy url — ignoring it`, { error: String(err?.message || err).slice(0, 120) });
    return null;
  }
  agents.set(url, agent);
  return agent;
}

export async function closeProxyAgents() {
  const all = [...agents.values()];
  agents.clear();
  await Promise.allSettled(all.map((a) => a.close?.()));
}

export const proxyAgentCount = () => agents.size;

// ── rotation ────────────────────────────────────────────────────────────────
// Per-provider cursor, in RAM (a restart merely restarts the cycle). Keyed by node id
// so two providers rotating the same pool list do not share a position.
const rotateState = new Map();

/**
 * Pick a pool id from a list.
 *   round-robin — cycle, advancing per request
 *   random      — uniform pick
 *   none/other  — the first entry (a fixed pool)
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!Array.isArray(poolIds) || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];
  if (strategy === "round-robin") {
    const next = ((rotateState.get(providerId) ?? -1) + 1) % poolIds.length;
    rotateState.set(providerId, next);
    return poolIds[next];
  }
  if (strategy === "random") return poolIds[Math.floor(Math.random() * poolIds.length)];
  return poolIds[0];
}

/** Reset rotation state (tests, and so a config change starts a clean cycle). */
export function resetProxyRotation() {
  rotateState.clear();
}

// ── resolution ──────────────────────────────────────────────────────────────

/** The usable proxy URL of a pool, or null. One URL per pool — see the header. */
export function poolUrl(pool) {
  const url = pool?.config?.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/** A pool is usable when it is enabled and carries a URL. */
export function poolUsable(pool) {
  return !!pool && pool.enabled !== false && !!poolUrl(pool);
}

/** `strict` is opt-out: a pool is strict unless it says otherwise. */
export function poolStrict(pool) {
  return pool?.config?.strict !== false;
}

/**
 * Which proxy this request should use, if any.
 *
 * Precedence (mirrors 9Router: pool → legacy → none):
 *   1. the connection's own pool  — per-key override, for one bad key or one account
 *      that must egress from a different address
 *   2. the provider's pool list   — fixed pool (strategy none) or rotation across pools
 *
 * Returns null when nothing applies, which is the direct-connection case.
 */
export function resolveNodeProxy(repos, node, connection = null) {
  const keyPoolId = connection?.credentials?.proxyPoolId;
  if (keyPoolId) {
    const pool = repos.proxyPools.get(keyPoolId);
    if (poolUsable(pool)) {
      return { poolId: pool.id, poolName: pool.name, url: poolUrl(pool), strict: poolStrict(pool), source: "key" };
    }
    // A pool that was deleted or disabled falls through to the provider setting rather
    // than failing the request — the key still has a working route.
    log.debug("PROXY", `key pool ${keyPoolId} is missing or disabled — using the provider setting`, { node: node?.prefix });
  }

  const cfg = node?.data?.proxy;
  const strategy = cfg?.strategy || "none";
  if (strategy === "none" && !cfg?.poolIds?.length) return null;

  // An explicit list is honoured; an empty one means "every enabled pool", which is how
  // a provider gets fleet-wide rotation without ticking each pool.
  const configured = Array.isArray(cfg?.poolIds) ? cfg.poolIds : [];
  const ids = configured.length
    ? configured
    : repos.proxyPools.list().filter((p) => poolUsable(p)).map((p) => p.id);
  const usable = ids.filter((id) => poolUsable(repos.proxyPools.get(id)));
  if (usable.length === 0) return null;

  const pickedId = pickProxyPoolId(usable, strategy, node.id);
  const pool = pickedId ? repos.proxyPools.get(pickedId) : null;
  if (!poolUsable(pool)) return null;
  return { poolId: pool.id, poolName: pool.name, url: poolUrl(pool), strict: poolStrict(pool), source: "provider" };
}

// ── health check ────────────────────────────────────────────────────────────

const TEST_URL = "https://www.google.com/";
const TEST_TIMEOUT_MS = 8000;

/**
 * Probe a proxy by sending a request THROUGH it.
 *
 * The previous implementation fetched the proxy URL itself, which is not a test of
 * anything — and which undici refuses outright when the URL carries credentials, so
 * every authenticated proxy reported "Request cannot be constructed from a URL that
 * includes credentials". A proxy is tested by asking it to reach a known host.
 */
export async function testProxyUrl(proxyUrl, { testUrl = TEST_URL, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const url = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  if (!url) return { ok: false, status: 400, error: "proxy url is required" };

  const agent = getProxyAgent(url);
  if (!agent) return { ok: false, status: 400, error: "invalid proxy url" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(timeoutMs) || TEST_TIMEOUT_MS, 30_000));
  const startedAt = Date.now();
  try {
    const res = await undiciFetch(testUrl, {
      method: "HEAD",
      dispatcher: agent,
      signal: controller.signal,
      headers: { "user-agent": "routy" },
    });
    return { ok: res.ok, status: res.status, elapsedMs: Date.now() - startedAt, testUrl };
  } catch (err) {
    // undici hides the real cause (ECONNREFUSED, ENOTFOUND, proxy auth) one level down;
    // "fetch failed" alone tells the user nothing about what to fix.
    const cause = err?.cause;
    const detail = [err?.name === "AbortError" ? "timed out" : err?.message, cause?.code, cause?.message]
      .filter(Boolean)
      .join(" · ");
    return { ok: false, status: 0, error: String(detail).slice(0, 200), elapsedMs: Date.now() - startedAt, testUrl };
  } finally {
    clearTimeout(timer);
  }
}
