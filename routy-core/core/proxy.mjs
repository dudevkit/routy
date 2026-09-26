// Outbound proxy support: fleets of exits, resolution, rotation, per-exit health, and the
// dispatcher that actually sends requests through a proxy.
//
// A pool is a FLEET of exits (one proxy URL each). That shape is what the reason for using
// proxies actually needs: the upstream meters per address, so N addresses are N times the
// allowance, and a fleet is only a fleet if requests are spread across it and a bad address
// drops out of rotation instead of taking every N-th request with it.
//
// Modelled on 9Router (open-sse/utils/proxyFetch.js, src/lib/network/connectionProxy.js)
// with one deliberate departure: `strict` defaults to TRUE. 9Router silently falls back to
// a direct request when a proxy fails; for the case people run a proxy here — the upstream
// rate-limits or bans the caller's address — a silent direct fallback leaks the real
// address and the request looks like it succeeded. Opt out per pool, not in.
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { log } from "../lib/log.mjs";
import { looksProviderWide } from "./key-health.mjs";
import { PROXY_COOLDOWN_MAX_MS, PROXY_COOLDOWN_MS } from "./limits.mjs";

// ProxyAgent owns its own connection pool to the proxy; the tuned per-origin Agent in
// executors/pool.mjs cannot be combined with it, so proxied requests trade the local
// connection reuse for the proxy's.
//
// The cap is generous because a fleet is tens of exits and the cache is FIFO: at 32, a
// 50-exit fleet evicts (and closes) an agent it is about to use again, paying a fresh
// proxy handshake per request — and closing an agent mid-flight can break a live request.
const MAX_PROXY_AGENTS = 128;
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

// ── exit health ─────────────────────────────────────────────────────────────
// One exit's state for ONE provider. An address that is exhausted on one upstream's free
// tier is still a good address for another, so cooling it globally would throw away the
// whole fleet's capacity for every provider at once.
//
// State lives in the existing breaker RAM store under `proxy:<entry>:<node>` scopes —
// same persistence (dirty-flush), same shape, zero new tables, and the dashboard's
// existing breaker reset endpoint can clear a single one.

export function entryScope(entryId, nodeId) {
  return `proxy:${entryId}:${nodeId}`;
}

export function entryHealth(repos, entryId, nodeId) {
  return repos.breakers.get(entryScope(entryId, nodeId)) || {
    scope: entryScope(entryId, nodeId), state: "closed", openUntil: null,
    failures: 0, lastError: null, updatedAt: "",
  };
}

/** May this exit carry a request right now? */
export function isExitAvailable(state, now = Date.now()) {
  if (!state) return true;
  if (state.state === "disabled") return false;
  if (state.state === "cooldown" && state.openUntil) {
    const until = Date.parse(state.openUntil);
    return !(Number.isFinite(until) && until > now);
  }
  return true;
}

/**
 * Whose fault is this failure — the exit's, or the provider's?
 *
 * Only three signals are evidence about the ADDRESS:
 *   connect-level failure   the exit could not be reached at all
 *   407                     the exit rejected our credentials
 *   429                     this address is being metered — unless the body names the
 *                           provider, in which case no address can fix it
 * Everything else (5xx, 401, a timeout) is about the provider, and cooling exits for it
 * would take the whole fleet out over one upstream's bad day.
 */
export function classifyProxyFailure({ status = 0, message = "", kind = null } = {}) {
  if (kind === "connect") return "exit";
  if (status === 407) return "exit";
  if (status === 429) return looksProviderWide(message) ? "provider" : "exit";
  return "provider";
}

// A per-day quota answers Retry-After with hours, and honouring that is the whole point of
// reading the header; the cap is only there to stop a nonsense value parking an exit for a
// week. Escalation of OUR default is capped separately, much lower.
const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
const COOLDOWN_STEP = 2;

function cooldownMsFor(state, failure, settings) {
  // An explicit Retry-After beats every default: it is the provider saying exactly how long
  // this address is spent. Otherwise the base is a setting (per-minute limits want a minute,
  // per-hour ones want longer) and doubles per repeat up to the cap.
  const retryAfter = Number(failure?.retryAfterMs);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, RETRY_AFTER_MAX_MS);
  const base = Number(settings?.proxyCooldownMs) > 0 ? Number(settings.proxyCooldownMs) : PROXY_COOLDOWN_MS;
  return Math.min(base * COOLDOWN_STEP ** Math.min(state.cooldownStreak ?? 0, 10), PROXY_COOLDOWN_MAX_MS);
}

/** Take an exit out of rotation, and say for how long. */
export function recordExitFailure(repos, { entryId, nodeId, failure, settings = null, now = Date.now() }) {
  const state = entryHealth(repos, entryId, nodeId);
  const cooldownMs = cooldownMsFor(state, failure, settings);
  const detail = `${failure?.reason || failure?.kind || "failed"}: ${String(failure?.detail || "").slice(0, 160)}`;
  const next = repos.breakers.record(entryScope(entryId, nodeId), {
    state: "cooldown",
    openUntil: new Date(now + cooldownMs).toISOString(),
    cooldownStreak: (state.cooldownStreak ?? 0) + 1,
    failureDelta: 1,
    lastError: detail,
  });
  log.warn("PROXY", `exit out of rotation for ${Math.round(cooldownMs / 1000)}s`, {
    entryId, nodeId, reason: failure?.reason || failure?.kind || null, detail: String(failure?.detail || "").slice(0, 140),
  });
  return { cooldownMs, state: next };
}

export function recordExitSuccess(repos, entryId, nodeId) {
  const state = entryHealth(repos, entryId, nodeId);
  if (state.state === "closed" && state.failures === 0 && !state.openUntil && !state.cooldownStreak) return state;
  return repos.breakers.record(entryScope(entryId, nodeId), {
    state: "closed", failures: 0, openUntil: null, lastError: null, cooldownStreak: 0,
  });
}

/**
 * Put every exit of a pool back in rotation — the manual escape hatch for a limit that
 * reset sooner than the cooldown promised, or a proxy the user has just fixed.
 */
export function resetPoolHealth(repos, poolId) {
  const ids = new Set(repos.proxyPoolEntries.listByPool(poolId).map((e) => e.id));
  let cleared = 0;
  for (const b of repos.breakers.all()) {
    const parts = String(b.scope || "").split(":");
    if (parts[0] !== "proxy" || !ids.has(parts[1])) continue;
    repos.breakers.record(b.scope, { state: "closed", failures: 0, openUntil: null, lastError: null, cooldownStreak: 0 });
    cleared++;
  }
  return cleared;
}

/**
 * Forget an exit's health. Called when the exit (or its pool) is deleted: its breaker scopes
 * describe a row that no longer exists, and leaving them behind would put phantom exits in
 * the breaker list and in any future reset.
 */
export function forgetExitHealth(repos, entryIds) {
  const ids = new Set(entryIds);
  if (ids.size === 0) return 0;
  let dropped = 0;
  for (const b of repos.breakers.all()) {
    const parts = String(b.scope || "").split(":");
    if (parts[0] !== "proxy" || !ids.has(parts[1])) continue;
    if (repos.breakers.drop(b.scope)) dropped++;
  }
  return dropped;
}

// ── rotation ────────────────────────────────────────────────────────────────
// Per-node cursor, in RAM (a restart merely restarts the cycle). Keyed by node id so two
// providers rotating the same fleet keep their own position.
const rotateState = new Map();

/**
 * Order the exits a request may use.
 *
 * The cursor advances once per REQUEST, not per attempt: attempts are the failover path,
 * and letting them move the cursor would make the next request resume in the middle of the
 * previous one's failures. When the healthy set changes size the offset shifts with it,
 * which is fine — the guarantee is "spread across the healthy exits", not a fixed stride.
 */
function orderExits(exits, strategy, nodeId) {
  if (exits.length < 2) return exits;
  if (strategy === "random") {
    const shuffled = [...exits];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  if (strategy !== "round-robin") return exits;
  const next = (rotateState.get(nodeId) ?? -1) + 1;
  rotateState.set(nodeId, next);
  const offset = next % exits.length;
  return [...exits.slice(offset), ...exits.slice(0, offset)];
}

/** Reset rotation state (tests, and so a config change starts a clean cycle). */
export function resetProxyRotation() {
  rotateState.clear();
}

// ── resolution ──────────────────────────────────────────────────────────────

/** `strict` is opt-out: a pool is strict unless it says otherwise. */
export function poolStrict(pool) {
  return pool?.config?.strict !== false;
}

/**
 * The identity of a proxy, for de-duplication: scheme + credentials + host + port.
 *
 * The path is deliberately NOT part of it. A proxy address is an endpoint, and a paste list
 * that reaches the same host twice — `host:8080` and `host:8080/anything` — is the same exit
 * twice, which is precisely the duplicate a pasted list hides. Credentials stay in: many
 * providers hand out a different account (and therefore a different address) per user:pass on
 * one host, and collapsing those would lose real capacity.
 */
export function proxyIdentity(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.username ? `${u.username}:${u.password}@` : ""}${u.host}`;
  } catch {
    return raw; // unparseable — compare as written rather than guess what it meant
  }
}

/** The exits of a pool that may carry traffic at all (enabled, with a URL). */
export function poolExits(repos, pool) {
  if (!pool) return [];
  return repos.proxyPoolEntries.listByPool(pool.id).filter((e) => e.enabled && e.url);
}

/**
 * A pool is usable when it is enabled and has at least one enabled exit.
 *
 * A pool with no exits is NOT usable, but it is also not "no proxy" — see
 * `resolveNodeProxy`, which fails such a request instead of quietly sending it direct.
 */
export function poolUsable(repos, pool) {
  return !!pool && pool.enabled !== false && poolExits(repos, pool).length > 0;
}

/** The single URL a one-shot request should use (probes) — the best exit, or null. */
export function primaryProxyUrl(plan) {
  return plan?.candidates?.[0]?.url ?? null;
}

function soonestFree(cooling, now) {
  const times = cooling
    .map((c) => Date.parse(c.state?.openUntil || ""))
    .filter((t) => Number.isFinite(t) && t > now);
  if (times.length === 0) return PROXY_COOLDOWN_MS;
  return Math.min(...times) - now;
}

/**
 * Which exits this request may use, and in what order.
 *
 * Precedence (mirrors 9Router: pool → legacy → none):
 *   1. the connection's own pool  — per-key override
 *   2. the provider's pool list   — a fixed fleet, or rotation across fleets
 *
 * Returns null when no proxy applies at all, which is the direct-connection case. Returns
 * a plan with ZERO candidates when a proxy is bound but cannot serve — a pool with no
 * exits, or every exit cooling — which the executor turns into an error rather than a
 * direct request: a binding that silently stops applying is worse than one that says why.
 *
 * `includeCooling` and `recordHealth` are for probes. A probe is a diagnostic the user
 * asked for, so it should see what the address does right now even if traffic is currently
 * avoiding it — and because it records no health, probing a cooling exit cannot extend the
 * cooldown it is sitting in.
 */
export function resolveNodeProxy(repos, node, connection = null, { now = Date.now(), includeCooling = false, recordHealth = true, settings = null } = {}) {
  let pools = [];
  let empties = [];
  let source = "provider";

  const keyPoolId = connection?.credentials?.proxyPoolId;
  if (keyPoolId) {
    const pool = repos.proxyPools.get(keyPoolId);
    if (poolUsable(repos, pool)) {
      pools = [pool];
      source = "key";
    } else {
      // A pool that was deleted, disabled or emptied falls through to the provider setting
      // rather than failing the request — the key still has a working route.
      log.debug("PROXY", `key pool ${keyPoolId} is missing, disabled or has no exits — using the provider setting`, { node: node?.prefix });
    }
  }

  const cfg = node?.data?.proxy;
  const strategy = cfg?.strategy || "none";
  if (pools.length === 0) {
    if (strategy === "none" && !cfg?.poolIds?.length) return null;
    const configured = Array.isArray(cfg?.poolIds) ? cfg.poolIds : [];
    if (configured.length) {
      const bound = configured.map((id) => repos.proxyPools.get(id)).filter(Boolean);
      pools = bound.filter((p) => poolUsable(repos, p));
      // Bound on purpose but not configured yet: fail loudly rather than go direct.
      empties = bound.filter((p) => p.enabled !== false && poolExits(repos, p).length === 0);
    } else {
      // An empty list means "every enabled pool", which is how a provider gets fleet-wide
      // rotation without ticking each pool.
      pools = repos.proxyPools.list().filter((p) => poolUsable(repos, p));
    }
    if (pools.length === 0 && empties.length === 0) return null;
  }

  const named = pools.length ? pools : empties;
  const target = named.map((p) => p.name).join(", ");
  const base = { source, target, strategy };

  const candidates = [];
  for (const pool of pools) {
    for (const entry of poolExits(repos, pool)) {
      candidates.push({
        entryId: entry.id, poolId: pool.id, poolName: pool.name,
        url: entry.url, strict: poolStrict(pool), egressIp: entry.egressIp,
      });
    }
  }

  if (candidates.length === 0) {
    const list = empties.map((p) => `"${p.name}"`).join(", ");
    return {
      ...base, candidates: [], directAllowed: false, skipped: 0,
      reason: empties.length
        ? `pool ${list} has no exits — add at least one proxy URL`
        : `no usable exits`,
    };
  }

  const healthy = [];
  const cooling = [];
  for (const c of candidates) {
    const state = entryHealth(repos, c.entryId, node.id);
    if (includeCooling || isExitAvailable(state, now)) healthy.push({ ...c, state });
    else cooling.push({ ...c, state });
  }

  const plan = {
    ...base,
    candidates: orderExits(healthy, strategy, node.id),
    // Direct is allowed only when NO bound pool forbids it: strict is a safety flag, and one
    // strict pool must not be defeated by a looser sibling in the same binding.
    directAllowed: pools.every((p) => !poolStrict(p)),
    skipped: cooling.length,
    retryAfterMs: null,
    reason: null,
  };

  if (plan.candidates.length === 0) {
    // Every exit is cooling. Trying one anyway is worse than failing: it will almost
    // certainly be refused again, and each refusal doubles that exit's cooldown — probing a
    // cooling exit is how a fleet talks itself into a lockout.
    plan.retryAfterMs = soonestFree(cooling, now);
    plan.reason = `all ${cooling.length} exit(s) of ${target} are cooling — the earliest is free in ${Math.max(1, Math.round(plan.retryAfterMs / 1000))}s`;
  }

  plan.onFailed = recordHealth
    ? (candidate, failure) => recordExitFailure(repos, { entryId: candidate.entryId, nodeId: node.id, failure, settings })
    : () => null;
  plan.onSucceeded = recordHealth
    ? (candidate) => { recordExitSuccess(repos, candidate.entryId, node.id); }
    : () => {};
  return plan;
}

// ── health check ────────────────────────────────────────────────────────────
// The default target is an IP echo rather than a plain reachability host. With a fleet the
// question that matters is not "does this proxy work" but "does this proxy look like a
// DIFFERENT address" — fifty entries sharing one exit are one address's allowance. The
// reply is parsed for an address and stored on the exit, so the fleet's real size is
// visible instead of assumed.
//
// `testUrl` overrides it per call, and the `proxyTestUrl` setting overrides it for the whole
// gateway: a fleet that cannot reach an external echo service is still checkable against a
// host it can, and without that escape the Test button only works by accident.
export const DEFAULT_PROXY_TEST_URL = "https://api.ipify.org?format=json";
const TEST_TIMEOUT_MS = 8000;

function isIpish(value) {
  if (!value || value.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return value.includes(":") && /^[0-9a-f:]+$/i.test(value);
}

/** Pull an address out of whatever the echo service answered with. */
export function parseEgressIp(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const field = parsed?.ip ?? parsed?.origin ?? parsed?.address ?? parsed?.query;
    if (typeof field === "string" && isIpish(field.trim())) return field.trim();
  } catch { /* not JSON — the regexes below still apply */ }
  const v4 = body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  if (v4) return v4[0];
  const first = body.split(/\s+/)[0];
  return isIpish(first) ? first : null;
}

/**
 * Probe a proxy by sending a request THROUGH it.
 *
 * The previous implementation fetched the proxy URL itself, which is not a test of
 * anything — and which undici refuses outright when the URL carries credentials, so every
 * authenticated proxy reported "Request cannot be constructed from a URL that includes
 * credentials". A proxy is tested by asking it to reach a known host.
 */
export async function testProxyUrl(proxyUrl, { testUrl = DEFAULT_PROXY_TEST_URL, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const url = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  if (!url) return { ok: false, status: 400, error: "proxy url is required" };

  const agent = getProxyAgent(url);
  if (!agent) return { ok: false, status: 400, error: "invalid proxy url" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(timeoutMs) || TEST_TIMEOUT_MS, 30_000));
  const startedAt = Date.now();
  try {
    const res = await undiciFetch(testUrl, {
      method: "GET",
      dispatcher: agent,
      signal: controller.signal,
      headers: { "user-agent": "routy", accept: "application/json, text/plain" },
    });
    const text = res.ok ? await res.text().catch(() => "") : "";
    return {
      ok: res.ok,
      status: res.status,
      elapsedMs: Date.now() - startedAt,
      testUrl,
      // Null when the target is not an echo service: "reachable" and "this address" are
      // different questions, and only the second one can be answered by the reply.
      egressIp: res.ok ? parseEgressIp(text) : null,
    };
  } catch (err) {
    // undici hides the real cause (ECONNREFUSED, ENOTFOUND, proxy auth) one level down;
    // "fetch failed" alone tells the user nothing about what to fix.
    const cause = err?.cause;
    const detail = [err?.name === "AbortError" ? "timed out" : err?.message, cause?.code, cause?.message]
      .filter(Boolean)
      .join(" · ");
    return { ok: false, status: 0, error: String(detail).slice(0, 200), elapsedMs: Date.now() - startedAt, testUrl, egressIp: null };
  } finally {
    clearTimeout(timer);
  }
}
