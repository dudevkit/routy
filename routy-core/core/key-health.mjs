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
// Only explicit provider-wide evidence justifies a global verdict. Multiple distinct
// credentials can independently exhaust their quotas; opaque 429s do not prove otherwise.
//
// State lives in the existing breaker RAM store under `conn:<id>` scopes — same
// persistence (dirty-flush), same shape, zero new tables. Disabled is always a manual
// act: the automatic path stops at cooldown, because a provider that briefly 401s during
// a billing hiccup must not cost the user their keys overnight.
import { CONNECTION_COOLDOWN_MS, CONNECTION_COOLDOWN_MAX_MS, CONNECTION_STRIKE_WINDOW_MS, CONNECTION_STRIKES_TO_DISABLE } from "./limits.mjs";

// Bodies (lowercased) that mean "this credential is out of credit". Providers word the
// 402/403 body inconsistently; a 402 without any of these still counts by status alone.
const CREDIT_BODY = /insufficient|quota|credit|balance|billing|exceeded your|plan limit/;

// The same question asked of a 400, which needs a stricter answer. A 402 or 403 is already
// a statement about the account — that status means payment or permission, so one keyword
// is corroboration. A 400 is overwhelmingly about the REQUEST, and its body describes the
// request, so a single keyword there is a coincidence waiting to happen: "invalid parameter:
// quota must be positive" and "insufficient permissions for model X" are both client errors
// that the loose list reads as "out of credit". Two of those within an hour would disable a
// key that is perfectly healthy, over a bug in the caller.
//
// So this one requires the shape of an account statement: a state word adjacent to a credit
// noun. Measured against ten bodies, the loose list scores 6 and this scores 10.
const CREDIT_400_BODY = /(insufficient|exceeds?|exceeded|not enough|out of|no|low)\s+(credit|credits|balance|quota|funds|budget)/;

// 429 bodies that point at the caller's credential rather than the provider. Absence
// of a match is not evidence of a provider-wide limit.
const KEY_SCOPED_429 = /your (api )?key|per[- ]key|this key|key.+limit|quota.+key|key.+quota/;

// Only wording that identifies shared saturation is provider-wide. Generic advice to
// retry, or saying that the upstream rate-limited us, does not establish scope.
const GLOBAL_429 = /\bglobal\b|all (keys|clients|users)|\bcapacity\b|\boverloaded\b|server is busy/;

// A cooldown doubles each time the same key 429s again after its cooldown expired, up to
// the cap — the same idea as the node breaker's exponential backoff.
const COOLDOWN_STEP = 2;

/**
 * Does this 429 body name the provider rather than the caller? Shared with proxy-exit
 * health, which asks the same question about an address: a limit that no address can fix
 * must not take exits out of rotation, and rotating is exactly what a fleet would do.
 */
export function looksProviderWide(body) {
  return GLOBAL_429.test(String(body || "").toLowerCase());
}

// 429 bodies that name the ADDRESS rather than the account: the only evidence that a
// proxy exit is what got metered. A body that says neither (opaque, or redacted by the
// executor) is not evidence against the exit — see classifyProxyFailure.
const ADDRESS_429 = /this (address|ip|network|host)|your (ip|address|network)|ip address|per[- ]ip|from this network|region|geolocat/;

/**
 * Does this 429 body blame the caller's network address? Only this wording justifies
 * cooling a proxy exit and spending the fleet on it.
 */
export function looksAddressScoped(body) {
  return ADDRESS_429.test(String(body || "").toLowerCase());
}

export function classifyConnectionError(err, { connection, recent429 } = {}) {
  const status = err?.status ?? 0;
  const body = String(err?.message || "").toLowerCase();

  // Credit BEFORE auth: a 403 with a credit body is an account problem, and the branch that
  // would have said so was unreachable while the auth check came first — a 403 carrying
  // "insufficient credits" was reported as an auth failure, which is the mislabelling that
  // makes this class of bug hard to see in the log.
  if (status === 402 || (status === 403 && CREDIT_BODY.test(body))) {
    return { verdict: "strike", reason: status === 402 ? "out of credit" : "credit body", disable: true };
  }
  if (status === 401 || status === 403) {
    return { verdict: "strike", reason: `auth ${status}`, disable: true };
  }
  // Some providers (b.ai, etc.) answer a credit error with HTTP 400 instead of 402/403.
  // Without this, it classified as a node failure: the breaker tripped and the key loop
  // broke, so the remaining healthy keys were never tried. The stricter body test above
  // (CREDIT_400_BODY) is what keeps a malformed REQUEST from being read as an empty account.
  if (status === 400 && CREDIT_400_BODY.test(body)) {
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
    // Redacted OAuth responses cannot identify the scope of the limit. Rotate without
    // sidelining the account or claiming the provider is globally saturated.
    if (connection?.credentials?.authType === "oauth") {
      return { verdict: "cooldown", reason: "unclassified rate limit on an OAuth account", soft: true };
    }
    return { verdict: "cooldown", reason: "rate limit (unclassified body)" };
  }
  // A request-shaped 4xx is the caller's mistake, not the provider's condition: the same body
  // would be rejected by any node that shares the upstream's opinion, and — the part that
  // bites — three of them used to open the node's breaker and take every model on it down.
  // 404 is deliberately NOT here: "this provider has no such model" is a per-node fact worth
  // falling through to the next route, which is what the node verdict already does.
  if (status === 400 || status === 413 || status === 422) {
    return { verdict: "client", reason: `request rejected (${status})` };
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
  // The anonymous connection of a keyless preset (id null): there is no key to charge a
  // failure to. "node" is the verdict chat already handles by charging the node breaker —
  // exactly where a keyless failure belongs.
  if (connection?.id == null) return { verdict: "node", reason: "keyless connection — charged to the node", strikes: 0, cooldownMs: 0 };
  const scope = connectionScope(connection.id);
  const state = connectionState(repos, connection.id);
  const verdict = classifyConnectionError(err, { connection, recent429 });

  // A `soft` verdict means "this attempt failed, but do not write health". The one case today
  // is an OAuth account's unclassifiable 429: its body is redacted by design, and a lone
  // subscription has no sibling credential to corroborate with, so charging it a cooldown
  // would take the user's only account out of rotation over a provider-wide limit.
  if (verdict.soft) {
    return { verdict: verdict.verdict, reason: verdict.reason, cooldownMs: 0, state, soft: true };
  }

  if (verdict.verdict === "global" || verdict.verdict === "node") {
    return { verdict: verdict.verdict, reason: verdict.reason, others: verdict.others, state };
  }

  if (err?.status === 429 && recent429) recent429.add(connection.id);

  if (verdict.verdict === "cooldown") {
    const ms = cooldownMsFor(state, err, settings);
    const next = repos.breakers.record(scope, {
      state: "cooldown",
      openUntil: new Date(now + ms).toISOString(),
      cooldownStreak: (state.cooldownStreak ?? 0) + 1,
      lastError: verdict.reason,
    });
    return { verdict: "cooldown", reason: verdict.reason, cooldownMs: ms, state: next, priorState: state };
  }

  // strike: count failures within the strike window; the second one inside the window
  // disables. A strike older than the window stops counting, so a transient provider
  // billing blip self-heals instead of waiting for a manual re-enable.
  const strikes = state.failures >= 1 ? 1 : 0; // prior strike (window checked below)
  const priorAt = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  const withinWindow = Number.isFinite(priorAt) && now - priorAt <= CONNECTION_STRIKE_WINDOW_MS;
  const count = strikes && withinWindow ? 2 : 1;
  const lastError = verdict.reason;

  if (count >= CONNECTION_STRIKES_TO_DISABLE) {
    const next = repos.breakers.record(scope, { state: "disabled", failures: count, lastError });
    repos.connections.update(connection.id, { status: "disabled", lastError });
    return { verdict: "disable", reason: verdict.reason, strikes: count, state: next };
  }
  const next = repos.breakers.record(scope, { failureDelta: count - state.failures, lastError });
  return { verdict: "strike", reason: verdict.reason, strikes: count, state: next };
}

export function recordConnectionSuccess(repos, connectionId) {
  // id null = the anonymous connection of a keyless preset — per-key state never existed.
  if (connectionId == null) return;
  const scope = connectionScope(connectionId);
  const state = connectionState(repos, connectionId);
  if (state.state === "closed" && state.failures === 0 && !state.openUntil && !state.cooldownStreak) return state;
  return repos.breakers.record(scope, { state: "closed", failures: 0, openUntil: null, lastError: null, cooldownStreak: 0 });
}

/** Undo a speculative cooldown only while it is still the latest health update. */
export function rollbackConnectionCooldown(repos, entry) {
  if (!entry || repos.breakers.get(connectionScope(entry.id)) !== entry.state) return;
  const prior = entry.priorState;
  repos.breakers.record(connectionScope(entry.id), {
    state: prior.state, failures: prior.failures, openUntil: prior.openUntil,
    lastError: prior.lastError, cooldownStreak: prior.cooldownStreak ?? 0,
  });
}

/** Clear a connection's health. Only an automatic breaker disable is re-enabled;
 * a manually disabled connection remains disabled until explicitly enabled. */
export function resetConnection(repos, connectionId) {
  if (connectionId == null) return null;
  const conn = repos.connections.get(connectionId);
  if (!conn) return null;
  const scope = connectionScope(connectionId);
  const autoDisabled = connectionState(repos, connectionId).state === "disabled";
  const state = repos.breakers.record(scope, {
    state: "closed", failures: 0, openUntil: null, lastError: null, cooldownStreak: 0,
  });
  if (autoDisabled && conn.status !== "active") repos.connections.update(connectionId, { status: "active", lastError: null });
  else if (conn.status === "active" && conn.lastError) repos.connections.update(connectionId, { lastError: null });
  return state;
}

/** Which connections does a `node:<id>` breaker scope own? (the reason-keyed reset needs this) */
export function connectionsForNode(repos, nodeId) {
  return repos.nodes.get(nodeId) ? repos.connections.list(nodeId) : [];
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
