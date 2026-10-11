// CodeBuddy Intl (www.codebuddy.ai) OAuth protocol client.
//
// Ported from 9router/src/lib/oauth/providers/codebuddy-intl.js +
// open-sse/services/tokenRefresh/providers.js (refreshCodebuddyIntlToken) and the
// registry at open-sse/providers/registry/codebuddy-intl.js. This is the ONLY module
// that talks to the CodeBuddy OAuth endpoints; everything above it (routes, flow
// manager, credential resolver) consumes its normalized results.
//
// Two things the reference does NOT do, and this port deliberately adds:
//   1. The verification URL is validated against a compile-time hostname allowlist
//      before it ever reaches the UI. The reference hands `authUrl` straight to
//      window.open with no check (OAuthModal.js). Verified live 2026-10-11: the
//      returned URL is https://www.codebuddy.ai/login?platform=ide&state=… — same
//      host as every registry endpoint — so the allowlist is exactly that host.
//   2. Every upstream response body is consumed and bounded; only allowlisted error
//      codes and generic safe messages escape. Raw bodies and token-shaped strings
//      must never reach logs, API errors, or stored diagnostics.
//
// It never spends chat quota: these are login-state/poll/refresh calls only.

const PROVIDER_ID = "codebuddy-intl";

// The registry's fixed endpoint set (www.codebuddy.ai). Constant by construction —
// no part is client-supplied.
export const CODEBUDDY_INTL = Object.freeze({
  providerId: PROVIDER_ID,
  host: "www.codebuddy.ai",
  stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
  tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
  refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
  chatUrl: "https://www.codebuddy.ai/v2/chat/completions",
  platform: "ide",
  oauthUserAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
  chatUserAgent: "IDE/2.108.1 CodeBuddy/2.108.1",
  pollIntervalMs: 5000,
  // Reference default for an omitted expiresIn; explicit malformed/nonpositive values
  // are rejected instead of silently defaulted (the reference's broad falsy fallback).
  defaultExpiresInSec: 86400,
});

// Exact-host allowlist for the browser verification URL. Match is case-insensitive and
// EXACT — no suffix wildcard, so `evil-www.codebuddy.ai` and `www.codebuddy.ai.evil.com`
// are both refused. Add a host only after the same live verification.
export const VERIFICATION_HOST_ALLOWLIST = Object.freeze(["www.codebuddy.ai"]);

/** Bounded request timeout and response-body cap for every OAuth HTTP call. */
export const OAUTH_TIMEOUT_MS = 15_000;
export const OAUTH_MAX_BODY_BYTES = 64 * 1024;

/**
 * A sanitized OAuth failure. `code` is an allowlisted machine token; `message` is a
 * generic human string. Never carries upstream text.
 */
export class OAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "OAuthError";
    this.code = code;
  }
}

/** Read a response body up to a byte cap, then discard the rest. Never returns more. */
async function readBounded(res, maxBytes = OAUTH_MAX_BODY_BYTES) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text().catch(() => "");
    return text.slice(0, maxBytes);
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total >= maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - (total - value.length))));
        break;
      }
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse JSON without ever throwing on a malformed/oversized body. */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function postJson(url, { headers, body = "{}", signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), OAUTH_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: merged });
    const text = await readBounded(res);
    return { status: res.status, ok: res.ok, data: safeJson(text) };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, { headers, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), OAUTH_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, { method: "GET", headers, signal: merged });
    const text = await readBounded(res);
    return { status: res.status, ok: res.ok, data: safeJson(text) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate the upstream `authUrl` before it is ever returned to the UI.
 * Fail-closed: a non-https scheme, embedded credentials, a fragment, an unparseable
 * URL, or any host outside the exact allowlist is rejected.
 */
export function validateVerificationUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { throw new OAuthError("invalid_verification_url", "the provider returned an unusable login URL"); }
  if (url.protocol !== "https:") throw new OAuthError("invalid_verification_url", "the provider returned a non-HTTPS login URL");
  if (url.username || url.password) throw new OAuthError("invalid_verification_url", "the provider returned a login URL with credentials");
  if (url.hash) throw new OAuthError("invalid_verification_url", "the provider returned a login URL with a fragment");
  const host = url.hostname.toLowerCase();
  if (!VERIFICATION_HOST_ALLOWLIST.includes(host)) {
    throw new OAuthError("untrusted_verification_host", `the login URL host "${host}" is not allowlisted`);
  }
  return url.toString();
}

/**
 * Start a login flow: request the upstream state and the browser verification URL.
 * Returns `{ upstreamState, verificationUrl, expiresAt }` — the caller keeps
 * `upstreamState` server-side and never returns it to the client.
 */
export async function startFlow({ signal } = {}) {
  const url = `${CODEBUDDY_INTL.stateUrl}?platform=${CODEBUDDY_INTL.platform}`;
  let res;
  try {
    res = await postJson(url, {
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CODEBUDDY_INTL.oauthUserAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": CODEBUDDY_INTL.host,
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
    });
  } catch {
    throw new OAuthError("upstream_unreachable", "could not reach the provider to start login");
  }
  if (!res.ok) throw new OAuthError("upstream_error", `the provider rejected the login start (HTTP ${res.status})`);
  const data = res.data;
  if (!data || data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
    throw new OAuthError("upstream_bad_response", "the provider did not return a login URL");
  }
  const verificationUrl = validateVerificationUrl(data.data.authUrl);
  return {
    upstreamState: String(data.data.state),
    verificationUrl,
    // No explicit upstream expiry on the state call; bound it locally.
    expiresAt: Date.now() + 10 * 60_000,
  };
}

/**
 * Poll one token result for a state. Returns a discriminated result:
 *   { state: "pending" }
 *   { state: "complete", tokens: { accessToken, refreshToken, expiresInSec, tokenType } }
 *   throws OAuthError on a terminal upstream failure.
 */
export async function pollFlow(upstreamState, { signal } = {}) {
  const url = `${CODEBUDDY_INTL.tokenUrl}?state=${encodeURIComponent(upstreamState)}`;
  let res;
  try {
    res = await getJson(url, {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": CODEBUDDY_INTL.oauthUserAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": CODEBUDDY_INTL.host,
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
    });
  } catch {
    throw new OAuthError("upstream_unreachable", "could not reach the provider while polling login");
  }
  // A non-2xx here is transient from the flow's point of view: the reference treats it
  // as `request_failed` and keeps polling.
  if (!res.ok) return { state: "pending" };
  const data = res.data;
  if (!data) throw new OAuthError("upstream_bad_response", "the provider returned an unreadable login response");
  if (data.code === 0 && data.data?.accessToken) {
    return { state: "complete", tokens: normalizeTokens(data.data, null) };
  }
  if (data.code === 11217) return { state: "pending" };
  throw new OAuthError("upstream_error", "the provider refused the login");
}

/**
 * Normalize an upstream token payload into Routy's credential shape.
 * Enforces a nonempty access token, an accepted token type, and expiry rules.
 * `previousRefreshToken` is retained when the provider rotates nothing.
 */
export function normalizeTokens(data, previousRefreshToken) {
  const accessToken = data?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthError("missing_access_token", "the provider did not return an access token");
  }
  const tokenType = data.tokenType ?? data.token_type ?? "Bearer";
  if (tokenType && String(tokenType).toLowerCase() !== "bearer") {
    throw new OAuthError("unsupported_token_type", "the provider returned an unsupported token type");
  }
  const rawExpires = data.expiresIn ?? data.expires_in;
  let expiresInSec;
  if (rawExpires === undefined || rawExpires === null || rawExpires === "") {
    expiresInSec = CODEBUDDY_INTL.defaultExpiresInSec;
  } else {
    const n = Number(rawExpires);
    if (!Number.isFinite(n) || n <= 0) throw new OAuthError("invalid_expiry", "the provider returned an invalid token expiry");
    expiresInSec = n;
  }
  const refreshToken = (typeof data.refreshToken === "string" && data.refreshToken)
    ? data.refreshToken
    : (typeof data.refresh_token === "string" && data.refresh_token)
      ? data.refresh_token
      : (previousRefreshToken ?? null);
  return { accessToken, refreshToken, expiresInSec, tokenType: "Bearer" };
}

/** Build the stored credential object from normalized tokens. */
export function credentialFromTokens(tokens, { now = Date.now(), previousRevision = 0, authState = "active" } = {}) {
  return {
    authType: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    expiresAt: new Date(now + tokens.expiresInSec * 1000).toISOString(),
    authState,
    oauthRevision: previousRevision + 1,
    providerSpecificData: {},
  };
}

/**
 * Refresh an access token. Throws `OAuthError` with a `transient` flag so the caller
 * can decide between a retryable failure and a definitive reauth:
 *   - transient (network / 5xx / unreadable body): keep credentials, retry later
 *   - definitive (provider says the refresh token is invalid/revoked): reauth-required
 * The reference collapses both into `null`; splitting them is what lets routing avoid
 * disabling a healthy account over a blip.
 */
export async function refreshTokens(refreshToken, { signal } = {}) {
  if (!refreshToken) throw new OAuthError("no_refresh_token", "this account has no refresh token");
  let res;
  try {
    res = await postJson(CODEBUDDY_INTL.refreshUrl, {
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CODEBUDDY_INTL.oauthUserAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": CODEBUDDY_INTL.host,
        "X-Refresh-Token": refreshToken,
        "X-Auth-Refresh-Source": "plugin",
        "X-Product": "SaaS",
      },
    });
  } catch {
    const err = new OAuthError("upstream_unreachable", "could not reach the provider to refresh the token");
    err.transient = true;
    throw err;
  }
  if (!res.ok) {
    const err = new OAuthError("upstream_error", `the provider rejected the refresh (HTTP ${res.status})`);
    // 5xx is transient; a 4xx is a statement about the credential. We do not have a
    // verified code that proves revocation, so even 4xx stays transient here — the
    // caller only marks reauth-required on an explicit definitive code (below).
    err.transient = res.status >= 500 || res.status === 408 || res.status === 429;
    err.status = res.status;
    throw err;
  }
  const data = res.data;
  if (!data) {
    const err = new OAuthError("upstream_bad_response", "the provider returned an unreadable refresh response");
    err.transient = true;
    throw err;
  }
  if (data.code !== 0 || !data.data?.accessToken) {
    // The reference treats any non-zero code as a failed refresh. We keep it transient
    // unless a future verification pins a revocation code; today no code is proven to
    // mean "revoked", so a wrong guess must not disable the account.
    const err = new OAuthError("refresh_rejected", "the provider refused to refresh this account");
    err.transient = true;
    err.providerCode = Number.isFinite(data.code) ? data.code : undefined;
    throw err;
  }
  return normalizeTokens(data.data, refreshToken);
}
