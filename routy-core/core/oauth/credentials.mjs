// OAuth credential resolution for CodeBuddy Intl chat dispatch.
//
// Resolves a connection's live access token immediately before an upstream call,
// refreshing when it is within the lead window. Two concurrency rules, both from the
// design doc:
//
//   1. SINGLE-FLIGHT BY PROVIDER + TOKEN FINGERPRINT. Two independently stored rows may
//      share one refresh token (no verified identity, so rows are never merged). A
//      per-connection lock alone would let both rows refresh the same token at once and
//      race the rotation. Refreshes are therefore deduplicated across rows by
//      provider + an ephemeral HMAC of the refresh token — the fingerprint is never
//      logged or stored, and the HMAC key is per-process (so it cannot be reversed from
//      a captured value across restarts).
//   2. ROW-SPECIFIC CAS. The shared refresh result is applied to each row under a
//      compare-and-swap on its own `oauthRevision`; a reconnect that installed newer
//      credentials makes the stale write a no-op.
//
// This module never records usage, budget, breakers, or key health — an OAuth auth
// failure is the OAuth lifecycle's business, not the API-key strike path.

import crypto from "node:crypto";
import { refreshTokens, credentialFromTokens, OAuthError } from "./codebuddyIntl.mjs";

/** A per-process secret for the token fingerprint. Never persisted, never logged. */
const FINGERPRINT_KEY = crypto.randomBytes(32);

export const REFRESH_LEAD_MS = 5 * 60_000;

/** In-flight refresh promises, keyed by `provider:fingerprint`. */
const inflight = new Map();

/** True when a connection carries CodeBuddy Intl OAuth credentials. */
export function isOAuthConnection(connection) {
  return connection?.credentials?.authType === "oauth";
}

export function authStateOf(connection) {
  const state = connection?.credentials?.authState;
  // A legacy row with no authState is active only once it has a nonempty access token;
  // anything else fails closed and needs a reconnect.
  if (!state) return connection?.credentials?.accessToken ? "active" : "reauth-required";
  return state;
}

/** Non-secret fields a safe connection view may expose. */
export function oauthViewFields(connection) {
  if (!isOAuthConnection(connection)) return {};
  return { authType: "oauth", authState: authStateOf(connection), accountLabel: connection.name };
}

function fingerprint(refreshToken) {
  return crypto.createHmac("sha256", FINGERPRINT_KEY).update(String(refreshToken)).digest("hex");
}

/** One shared upstream refresh for a provider+token, reused by every row that needs it. */
function singleFlight(provider, refreshToken, fn) {
  const key = `${provider}:${fingerprint(refreshToken)}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try { return await fn(); } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

/** True when the access token is missing or within the refresh lead window. */
function needsRefresh(credentials, now) {
  const at = credentials?.expiresAt ? Date.parse(credentials.expiresAt) : NaN;
  if (!Number.isFinite(at)) return false; // legacy row with no expiry: never refresh forever
  return at - now <= REFRESH_LEAD_MS;
}

/**
 * Resolve a connection into one whose credentials carry a live access token.
 *
 * @returns {{ ok: true, connection, refreshed: boolean } |
 *           { ok: false, reason: "reauth-required" | "transient", error: OAuthError }}
 */
export async function resolveOAuthCredentials(repos, node, connection, { now = Date.now(), log = null } = {}) {
  if (!isOAuthConnection(connection)) return { ok: true, connection, refreshed: false };

  if (authStateOf(connection) === "reauth-required") {
    return { ok: false, reason: "reauth-required", error: new OAuthError("reauth_required", "this account needs to be reconnected") };
  }

  const credentials = connection.credentials;
  if (!needsRefresh(credentials, now)) return { ok: true, connection, refreshed: false };

  // Expired and no refresh token: this account can only be reconnected. Mark it so, but
  // never claim a provider-side revocation we did not observe.
  if (!credentials.refreshToken) {
    markReauthRequired(repos, connection);
    return { ok: false, reason: "reauth-required", error: new OAuthError("reauth_required", "this account's session expired — reconnect it") };
  }

  const observedRevision = Number.isFinite(credentials.oauthRevision) ? credentials.oauthRevision : 0;
  const observedRefresh = credentials.refreshToken;

  let tokens;
  try {
    tokens = await singleFlight(node.data?.authProvider || "codebuddy-intl", observedRefresh, () => refreshTokens(observedRefresh));
  } catch (err) {
    // A transient failure keeps credentials and lets the request fall back to another
    // account/node. A definitive one (never produced today — no code is proven to mean
    // "revoked") would mark reauth-required.
    if (err?.transient === false) {
      markReauthRequired(repos, connection);
      return { ok: false, reason: "reauth-required", error: err };
    }
    log?.warn?.("OAUTH", `${node.prefix} token refresh failed transiently — ${err?.code || "error"}`, { nodeId: node.id, connectionId: connection.id });
    return { ok: false, reason: "transient", error: err };
  }

  // Apply with CAS: if a reconnect or another refresh already moved the row, keep theirs.
  const nextCreds = credentialFromTokens(tokens, { now, previousRevision: observedRevision, authState: "active" });
  const updated = repos.oauth.casCredentials(connection.id, {
    expectedRevision: observedRevision,
    expectedRefreshToken: observedRefresh,
    credentials: nextCreds,
    status: connection.status,
    lastError: null,
  });
  if (!updated) {
    // Lost the race: re-read and use the newer credentials.
    const fresh = repos.connections.get(connection.id);
    if (fresh && authStateOf(fresh) !== "reauth-required") return { ok: true, connection: fresh, refreshed: true };
    return { ok: false, reason: "reauth-required", error: new OAuthError("reauth_required", "this account was reconnected — retry") };
  }
  log?.info?.("OAUTH", `${node.prefix} refreshed account token`, { nodeId: node.id, connectionId: connection.id, revision: nextCreds.oauthRevision });
  return { ok: true, connection: updated, refreshed: true };
}

/** Persist `reauth-required` without touching the ordinary connection status. */
export function markReauthRequired(repos, connection) {
  const credentials = connection.credentials || {};
  const revision = Number.isFinite(credentials.oauthRevision) ? credentials.oauthRevision : 0;
  repos.oauth.casCredentials(connection.id, {
    credentials: { ...credentials, authState: "reauth-required", oauthRevision: revision + 1 },
  });
}

/**
 * After a chat call definitively rejects the bearer token: refresh once and replay.
 * Returns a fresh connection when a replay is warranted, else null.
 */
export async function refreshAfterAuthRejection(repos, node, connection, { log = null } = {}) {
  if (!isOAuthConnection(connection)) return null;
  const credentials = connection.credentials || {};
  if (!credentials.refreshToken) {
    markReauthRequired(repos, connection);
    return null;
  }
  const observedRevision = Number.isFinite(credentials.oauthRevision) ? credentials.oauthRevision : 0;
  const observedRefresh = credentials.refreshToken;
  let tokens;
  try {
    tokens = await singleFlight(node.data?.authProvider || "codebuddy-intl", observedRefresh, () => refreshTokens(observedRefresh));
  } catch (err) {
    if (err?.transient === false) markReauthRequired(repos, connection);
    return null;
  }
  const nextCreds = credentialFromTokens(tokens, { previousRevision: observedRevision, authState: "active" });
  const updated = repos.oauth.casCredentials(connection.id, {
    expectedRevision: observedRevision,
    expectedRefreshToken: observedRefresh,
    credentials: nextCreds,
    lastError: null,
  });
  log?.info?.("OAUTH", `${node.prefix} refreshed after auth rejection`, { nodeId: node.id, connectionId: connection.id });
  return updated || repos.connections.get(connection.id);
}
