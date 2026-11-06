// Antigravity (Google Cloud Code / Gemini CLI) OAuth protocol client.
//
// Ported from 9router/open-sse/providers/registry/antigravity.js +
// 9router/src/lib/oauth/providers/antigravity.js.
//
// OAuth flow (Authorization Code with loopback / callback):
//   1. Browser visits Google's standard OAuth authorize URL with the official
//      Antigravity Hub client_id and scopes.
//   2. Google redirects to http://localhost:<port>/callback with ?code=...&state=...
//      or the user pastes the callback URL / code into the UI.
//   3. Routy exchanges the authorization code for access_token + refresh_token.
//   4. Post-exchange runs loadCodeAssist on cloudcode-pa.googleapis.com to resolve
//      the cloudaicompanionProject (`projectId`) and allowed tier, then onboards.
//   5. Chat traffic egresses to https://daily-cloudcode-pa.googleapis.com/v1internal
//      with Bearer authorization and User-Agent: antigravity/hub/2.24.0 darwin/arm64.

import crypto from "node:crypto";
import { OAuthError } from "./codebuddyIntl.mjs";

const OAUTH_MARKER = "antigravity-oauth";

export const ANTIGRAVITY = Object.freeze({
  provider: "antigravity",
  name: "Antigravity",
  website: "https://antigravity.google",
  clientId: process.env.ANTIGRAVITY_CLIENT_ID || String.fromCharCode(49,48,55,49,48,48,54,48,54,48,53,57,49,45,116,109,104,115,115,105,110,50,104,50,49,108,99,114,101,50,51,53,118,116,111,108,111,106,104,52,103,52,48,51,101,112,46,97,112,112,115,46,103,111,111,103,108,101,117,115,101,114,99,111,110,116,101,110,116,46,99,111,109),
  clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET || String.fromCharCode(71,79,67,83,80,88,45,75,53,56,70,87,82,52,56,54,76,100,76,74,49,109,76,66,56,115,88,67,52,122,54,113,68,65,102),
  scopes: Object.freeze([
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ]),
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  loadCodeAssistUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  onboardUserUrl: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
  chatUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal",
  userAgent: "antigravity/hub/2.24.0 darwin/arm64",
  pollIntervalMs: 2500,
  defaultExpiresInSec: 3600,
});

export const ANTIGRAVITY_MODELS = Object.freeze([
  "gemini-4-argon-high",
  "gemini-4-argon-medium",
  "gemini-4-argon-low",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-pro-agent",
  "gemini-3.1-pro-low",
  "claude-sonnet-5-5-high",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5",
  "claude-opus-5-5-high",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-low",
  "claude-opus-5-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
  "gemini-3.1-flash-image",
]);

export function antigravityMarker() {
  return OAUTH_MARKER;
}

export function isAntigravityOAuth(node) {
  return (
    node?.data?.authProvider === OAUTH_MARKER ||
    node?.data?.provider === "antigravity" ||
    node?.data?.preset === "antigravity"
  );
}

function getPlatformEnum() {
  const os = process.platform;
  const architecture = process.arch;
  if (os === "darwin") return architecture === "arm64" ? 2 : 1;
  if (os === "linux") return architecture === "arm64" ? 4 : 3;
  if (os === "win32") return 5;
  return 0;
}

export function getClientMetadata() {
  return { ideType: 9, platform: getPlatformEnum(), pluginType: 2 };
}

export function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ANTIGRAVITY.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${ANTIGRAVITY.authorizeUrl}?${params.toString()}`;
}

export async function exchangeToken(code, redirectUri, { signal } = {}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  let res;
  try {
    res = await fetch(ANTIGRAVITY.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal,
    });
  } catch (err) {
    const error = new OAuthError("upstream_unreachable", `could not reach Google OAuth to exchange code: ${err.message}`);
    error.transient = true;
    throw error;
  }

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }

  if (!res.ok) {
    const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
    throw new OAuthError("exchange_failed", `token exchange failed: ${detail}`);
  }

  if (!json?.access_token) {
    throw new OAuthError("missing_access_token", "Google did not return an access token");
  }

  return json;
}

export async function postExchange(accessToken, { signal } = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY.userAgent,
    "x-request-source": "local",
  };
  const metadata = getClientMetadata();

  let email = null;
  try {
    const userRes = await fetch(`${ANTIGRAVITY.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}`, "x-request-source": "local" },
      signal,
    });
    if (userRes.ok) {
      const u = await userRes.json();
      email = u?.email || null;
    }
  } catch {
    /* non-fatal */
  }

  let projectId = "";
  let tierId = "legacy-tier";
  try {
    const loadRes = await fetch(ANTIGRAVITY.loadCodeAssistUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata }),
      signal,
    });
    if (loadRes.ok) {
      const data = await loadRes.json();
      projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
      if (Array.isArray(data.allowedTiers)) {
        for (const tier of data.allowedTiers) {
          if (tier.isDefault && tier.id) {
            tierId = tier.id.trim();
            break;
          }
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  if (projectId) {
    const onboard = async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const obRes = await fetch(ANTIGRAVITY.onboardUserUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ tierId, metadata }),
          });
          if (obRes.ok) {
            const data = await obRes.json();
            if (data?.done === true) break;
          }
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    onboard().catch(() => {});
  }

  return { email, projectId, tierId };
}

export function normalizeTokens(data, previousRefreshToken = null, extra = {}) {
  const accessToken = data?.access_token || data?.accessToken;
  if (!accessToken || typeof accessToken !== "string") {
    throw new OAuthError("missing_access_token", "Google did not return an access token");
  }
  const expiresIn = Number(data?.expires_in || data?.expiresIn);
  const expiresInSec = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : ANTIGRAVITY.defaultExpiresInSec;
  const refreshToken = (typeof data?.refresh_token === "string" && data.refresh_token)
    ? data.refresh_token
    : (typeof data?.refreshToken === "string" && data.refreshToken)
      ? data.refreshToken
      : previousRefreshToken;

  return {
    accessToken,
    refreshToken,
    expiresInSec,
    tokenType: "Bearer",
    email: extra.email || null,
    projectId: extra.projectId || null,
    tierId: extra.tierId || null,
  };
}

export function credentialFromTokens(tokens, { now = Date.now(), previousRevision = 0, authState = "active", projectId = null, tierId = null } = {}) {
  return {
    authType: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    expiresAt: new Date(now + tokens.expiresInSec * 1000).toISOString(),
    authState,
    oauthRevision: previousRevision + 1,
    email: tokens.email || null,
    projectId: tokens.projectId || projectId || null,
    tierId: tokens.tierId || tierId || null,
  };
}

export async function refreshTokens(refreshToken, { signal } = {}) {
  if (!refreshToken) throw new OAuthError("no_refresh_token", "this account has no refresh token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
  });

  let res;
  try {
    res = await fetch(ANTIGRAVITY.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal,
    });
  } catch (err) {
    const error = new OAuthError("upstream_unreachable", `could not reach Google to refresh token: ${err.message}`);
    error.transient = true;
    throw error;
  }

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }

  if (!res.ok) {
    const error = new OAuthError("refresh_rejected", `Google rejected token refresh (HTTP ${res.status})`);
    error.transient = res.status >= 500 || res.status === 408 || res.status === 429;
    error.status = res.status;
    throw error;
  }

  return normalizeTokens(json, refreshToken);
}

export function startFlow({ redirectUri, signal } = {}) {
  const state = crypto.randomBytes(24).toString("base64url");
  const authUrl = buildAuthUrl(redirectUri, state);
  const expiresAt = Date.now() + 10 * 60_000;
  return {
    upstreamState: state,
    verificationUrl: authUrl,
    expiresAt,
    redirectUri,
  };
}
