// Per-API-key health: rotation, cooldown, strikes, and the global-rate-limit verdict.
//
// Node breakers answer "is this provider reachable?" — a 502 or a timeout is the node's
// fault, and rotating keys against a dead upstream just multiplies the damage by the key
// count. This module answers the orthogonal question "is THIS credential allowed to
// talk?", which only three signals can trigger:
//
//   401/403           the credential itself is rejected
//   402 / credit body the credential has no balance
//   key-scoped 429    this credential's own rate limit
//
// A provider-wide 429 ("the model is saturated for everyone") must NOT cool keys down —
// disabling every key against a problem no key can fix is how you wake up to a bricked
// provider. Detection is behavioral first, textual second: the same model returning 429
// on two different connections within one cooldown window is not a per-key event, no
// matter how the provider words the body. In that case the request must reach the client
// as upstream_rate_limited so a human can pick another model instead of the gateway
// silently churning its whole key list.
//
// State lives in the existing breaker RAM store under `conn:<id>` scopes — same
// persistence (dirty-flush), same shape, zero new tables. Disabled is always a manual
// act: the automatic path stops at cooldown, because a provider that briefly 401s during
// a billing hiccup must not cost the user their keys overnight.
import { CONNECTION_COOLDOWN_MS, CONNECTION_COOLDOWN_MAX_MS, CONNECTION_STRIKE_WINDOW_MS, CONNECTION_STRIKES_TO_DISABLE } from "./limits.mjs";

// Bodies (lowercased) that mean "this credential is out of credit". Providers word the
// 402/403 body inconsistently; a 402 without any of these still counts by status alone.
const CREDIT_BODY = /insufficient|quota|credit|balance|billing|exceeded your|plan limit/;

// 429 bodies that point at the caller's credential rather than the provider. Matched
// against the lowercased body; absence of a match is not evidence either way, which is
// what the two-connections heuristic is for.
const KEY_SCOPED_429 = /your (api )?key|per[- ]key|this key|key.+limit|quota.+key|key.+quota/;

// 429 bodies that name the provider rather than the caller: the model is saturated for
// everyone, so no key can fix it and none should be punished for it. These providers
// phrase it as "global"/"upstream"; "try again later" and "capacity" stand alone.
const GLOBAL_429 = /global|upstream|all (keys|clients|users)|try again later|capacity|overloaded|server is busy/;

// A cooldown doubles each time the same key 429s again after its cooldown expired, up to
// the cap — the same idea as the node breaker's exponential backoff.
const COOLDOWN_STEP = 2;

export function classifyConnectionError(err, { connection, recent429 } = {}) {
  const status = err?.status ?? 0;
  const body = String(err?.message || "").toLowerCase();

  if (status === 401 || status === 403) {
    return { verdict: "strike", reason: `auth ${status}`, disable: true };
  }
  if (status === 402 || (status === 403 && CREDIT_BODY.test(body))) {
    return { verdict: "strike", reason: status === 402 ? "out of credit" : "credit body", disable: true };
  }
  // Some providers (b.ai, etc.) return HTTP 400 with a credit body instead of 402/403.
  // Without this, "credit insufficient balance" on a 400 is misclassified as a node-level
  // failure, so the gateway burns the whole node breaker and never rolls to the next key.
  if (status === 400 && CREDIT_BODY.test(body)) {
    return { verdict: "strike", reason: "credit body", disable: true };
  }
  if (status === 429) {
    // Strongest signal first: a body that plainly names the caller's credential is
    // per-key no matter what anything else says.
    if (KEY_SCOPED_429.test(body)) {
      return { verdict: "cooldown", reason: "key rate limit" };
    }
    // A body that plainly names the provider is global on first occurrence.
    if (GLOBAL_429.test(body)) {
      return { verdict: "global", reason: "provider-wide limit in body", others: recent429?.size ?? 0 };
    }
    // Bodies are worded inconsistently, so behavior is the fallback: two different
    // connections 429ing on the same model inside one window is a provider-wide event.
    if (recent429 && [...recent429].some((id) => id !== connection?.id)) {
      return { verdict: "global", reason: "429 on multiple keys", others: recent429.size };
    }
    // Unrecognized body: still treated as this key's problem, but the next distinct
    // key to 429 flips the verdict to global via recent429.
    return { verdict: "cooldown", reason: "rate limit (unclassified body)" };
  }
  // Everything else (5xx, timeouts, network) is the node's problem, not the key's.
  return { verdict: "node", reason: err?.errorCode || `status ${status}` };
}

function cooldownMsFor(state, err, settings) {
  // An explicit Retry-After from the provider beats every default: it is the one case
  // where the upstream tells us exactly how long to wait. Otherwise the cooldown
  // doubles per repeat — tracked as its own counter so strikes and cooldowns never
  // contaminate each other — and caps out.
  if (err?.retryAfterMs && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) return err.retryAfterMs;
  const base = settings?.keyCooldownMs ?? CONNECTION_COOLDOWN_MS;
  return Math.min(base * COOLDOWN_STEP ** Math.min(state.cooldownStreak ?? 0, 10), CONNECTION_COOLDOWN_MAX_MS);
}

/** Where the per-key state lives: the same RAM store node breakers use. */
export function connectionScope(connectionId) {
  return `conn:${connectionId}`;
}

export function connectionState(repos, connectionId) {
  return repos.breakers.get(connectionScope(connectionId)) || {
    scope: connectionScope(connectionId), state: "closed", openUntil: null,
    failures: 0, lastError: null, updatedAt: "",
  };
}

/**
 * Apply a classified failure to a connection's health.
 * Returns the new state plus what the caller should log/do (`cooldown` also carries the
 * effective cooldown in ms; `disable` means the automatic path has decided this key is
 * out; `global`/`node` leave the connection untouched).
 */
export function recordConnectionFailure(repos, connection, err, settings = {}, now = Date.now(), recent429 = null) {
  const scope = connectionScope(connection.id);
  const state = connectionState(repos, connection.id);
  const verdict = classifyConnectionError(err, { connection, recent429 });

  if (verdict.verdict === "global" || verdict.verdict === "node") {
    return { verdict: verdict.verdict, reason: verdict.reason, others: verdict.others, state };
  }

  // This key's own 429 is now on record: a second distinct key 429ing on the same
  // model within the window is what flips the verdict to provider-wide.
  if (err?.status === 429 && recent429) recent429.add(connection.id);

  if (verdict.verdict === "cooldown") {
    const ms = cooldownMsFor(state, err, settings);
    const next = repos.breakers.record(scope, {
      state: "cooldown",
      openUntil: new Date(now + ms).toISOString(),
      cooldownStreak: (state.cooldownStreak ?? 0) + 1,
      lastError: `${verdict.reason}: ${String(err?.message || "").slice(0, 160)}`,
    });
    return { verdict: "cooldown", reason: verdict.reason, cooldownMs: ms, state: next };
  }

  // strike: count failures within the strike window; the second one inside the window
  // disables. A strike older than the window stops counting, so a transient provider
  // billing blip self-heals instead of waiting for a manual re-enable.
  const strikes = state.failures >= 1 ? 1 : 0; // prior strike (window checked below)
  const priorAt = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  const withinWindow = Number.isFinite(priorAt) && now - priorAt <= CONNECTION_STRIKE_WINDOW_MS;
  const count = strikes && withinWindow ? 2 : 1;
  const lastError = `${verdict.reason}: ${String(err?.message || "").slice(0, 160)}`;

  if (count >= CONNECTION_STRIKES_TO_DISABLE) {
    const next = repos.breakers.record(scope, { state: "disabled", failures: count, lastError });
    repos.connections.update(connection.id, { status: "disabled", lastError });
    return { verdict: "disable", reason: verdict.reason, strikes: count, state: next };
  }
  const next = repos.breakers.record(scope, { failureDelta: count - state.failures, lastError });
  return { verdict: "strike", reason: verdict.reason, strikes: count, state: next };
}

export function recordConnectionSuccess(repos, connectionId) {
  const scope = connectionScope(connectionId);
  const state = connectionState(repos, connectionId);
  if (state.state === "closed" && state.failures === 0 && !state.openUntil && !state.cooldownStreak) return state;
  return repos.breakers.record(scope, { state: "closed", failures: 0, openUntil: null, lastError: null, cooldownStreak: 0 });
}

/** Is this connection allowed to serve right now? */
export function isConnectionAvailable(state, now = Date.now()) {
  if (!state) return true;
  if (state.state === "disabled") return false;
  if (state.state === "cooldown" && state.openUntil) {
    const until = Date.parse(state.openUntil);
    return !(Number.isFinite(until) && until > now);
  }
  return true;
}

/** Soonest moment a cooling key comes back, for the all-exhausted retryAfterMs. */
export function earliestRecovery(repos, connections, now = Date.now()) {
  let soonest = null;
  for (const c of connections) {
    const s = connectionState(repos, c.id);
    if (s.state !== "cooldown" || !s.openUntil) continue;
    const until = Date.parse(s.openUntil);
    if (Number.isFinite(until) && until > now && (soonest === null || until < soonest)) soonest = until;
  }
  return soonest;
}
