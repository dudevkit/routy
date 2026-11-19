// OpenAI Codex public-client OAuth authorization code flow.
import crypto from "node:crypto";
import http from "node:http";
import { OAuthError } from "./codebuddyIntl.mjs";

export const CODEX = Object.freeze({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  chatUrl: "https://chatgpt.com/backend-api/codex/responses",
  pollIntervalMs: 4000,
});
export const codexMarker = () => "codex-oauth";
export const isCodexOAuth = (node) => node?.data?.authProvider === codexMarker();

export function startFlow() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: CODEX.clientId,
    redirect_uri: CODEX.redirectUri, scope: "openid profile email offline_access",
    code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" });
  return { verificationUrl: `${CODEX.authorizeUrl}?${params}`, upstreamState: { state, verifier }, expiresAt: Date.now() + 600_000 };
}

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}
function normalize(data, oldRefreshToken = null) {
  if (typeof data?.access_token !== "string" || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) {
    const err = new OAuthError("upstream_bad_response", "the provider returned an invalid token response");
    err.transient = true;
    throw err;
  }
  const id = claims(data.id_token || "");
  const access = claims(data.access_token);
  const auth = access["https://api.openai.com/auth"] || {};
  const idAuth = id["https://api.openai.com/auth"] || {};
  return { accessToken: data.access_token, refreshToken: data.refresh_token || oldRefreshToken,
    idToken: typeof data.id_token === "string" && data.id_token ? data.id_token : null,
    expiresInSec: Number(data.expires_in), chatgptAccountId: auth.chatgpt_account_id || idAuth.chatgpt_account_id || null, email: id.email || null };
}
async function tokenRequest(params, previousRefreshToken = null) {
  let response;
  try {
    response = await fetch(CODEX.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: params.toString(), signal: AbortSignal.timeout(30_000) });
  } catch {
    const err = new OAuthError("upstream_unreachable", "could not reach the OAuth provider"); err.transient = true; throw err;
  }
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const err = new OAuthError("token_request_failed", `OAuth token request failed (HTTP ${response.status})`);
    err.transient = !(data?.error === "invalid_grant" && response.status >= 400 && response.status < 500);
    throw err;
  }
  return normalize(data, previousRefreshToken);
}
export function exchangeToken(code, verifier) {
  return tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: CODEX.clientId, code, redirect_uri: CODEX.redirectUri, code_verifier: verifier }));
}
export function refreshTokens(refreshToken) {
  return tokenRequest(new URLSearchParams({ grant_type: "refresh_token", client_id: CODEX.clientId, refresh_token: refreshToken }), refreshToken);
}
export function credentialFromTokens(tokens, { now = Date.now(), previousRevision = 0, authState = "active", previousCredentials = null, chatgptAccountId = null } = {}) {
  return { authType: "oauth", accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? previousCredentials?.refreshToken ?? null,
    idToken: tokens.idToken ?? previousCredentials?.idToken ?? null,
    lastRefreshAt: new Date(now).toISOString(),
    expiresAt: new Date(now + tokens.expiresInSec * 1000).toISOString(), authState, oauthRevision: previousRevision + 1,
    providerSpecificData: { ...previousCredentials?.providerSpecificData, chatgptAccountId: tokens.chatgptAccountId || chatgptAccountId || previousCredentials?.providerSpecificData?.chatgptAccountId || null } };
}

// One loopback listener serves all outstanding flows; state is consumed exactly once.
const callbacks = new Map();
let listenerPromise;
export function ensureCallbackListener() {
  if (listenerPromise) return listenerPromise;
  listenerPromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.headers.host !== "localhost:1455") { res.writeHead(400).end(); return; }
      let url;
      try { url = new URL(req.url, CODEX.redirectUri); } catch { res.writeHead(400).end(); return; }
      if (req.method !== "GET" || url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
      const state = url.searchParams.get("state");
      const entry = callbacks.get(state);
      if (!entry || !url.searchParams.get("code") || url.searchParams.has("error")) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Invalid or expired OAuth callback."); return;
      }
      callbacks.delete(state); clearTimeout(entry.timer);
      try {
        const result = await entry.callback(url.searchParams.get("code"));
        const ok = result?.state === "pending" || result?.state === "complete";
        res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(ok ? "Authentication complete. You may close this tab." : "Authentication failed. Return to the dashboard.");
      } catch { res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Authentication failed. Return to the dashboard."); }
    });
    server.once("error", reject);
    server.listen(1455, "localhost", () => { server.unref(); resolve(server); });
  }).catch((err) => { listenerPromise = null; throw err; });
  return listenerPromise;
}
export function registerCallback(state, expiresAt, callback) {
  const timer = setTimeout(() => callbacks.delete(state), Math.max(0, expiresAt - Date.now()));
  timer.unref?.();
  callbacks.set(state, { callback, timer });
  return () => { const entry = callbacks.get(state); if (entry) { clearTimeout(entry.timer); callbacks.delete(state); } };
}
