/**
 * Dashboard auth.
 *
 * There is no credential for the client to hold: the session is an HttpOnly cookie the
 * server sets, so the browser attaches it to every same-origin request on its own, and
 * no script on the page can read it. That is strictly better than the token this
 * replaced, which lived in localStorage where any injected script could take it.
 *
 * All this module does is ask the gateway what it wants and tell the shell when the
 * answer changes.
 */
export interface AuthState {
  /** this request was allowed through */
  authed: boolean;
  /** a login is required for non-loopback peers */
  requireLogin: boolean;
  /** reachable from the network with no login at all — the banner case */
  unlockedNetwork: boolean;
  /** still on the shipped default password */
  passwordIsDefault: boolean;
}

const UNKNOWN: AuthState = {
  authed: true,
  requireLogin: true,
  unlockedNetwork: false,
  passwordIsDefault: false,
};

export async function fetchAuthState(): Promise<AuthState> {
  try {
    const res = await fetch("/api/auth");
    if (!res.ok) return UNKNOWN;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return UNKNOWN;
    const rec = body as Record<string, unknown>;
    return {
      authed: rec.authed === true,
      requireLogin: rec.requireLogin !== false,
      unlockedNetwork: rec.unlockedNetwork === true,
      passwordIsDefault: rec.passwordIsDefault === true,
    };
  } catch {
    return UNKNOWN; // a network failure is not an auth problem
  }
}

export async function login(password: string): Promise<{ ok: boolean; detail?: string }> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-routy-action": "1" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return { ok: true };
  const body: unknown = await res.json().catch(() => null);
  const err = (body as { error?: { detail?: string; message?: string } } | null)?.error;
  return { ok: false, detail: err?.detail ?? err?.message ?? `HTTP ${res.status}` };
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", headers: { "x-routy-action": "1" } }).catch(() => {});
}

/**
 * The session expired, or the server rejected it. Raised as an event rather than a
 * callback so the transport does not have to import React — the shell subscribes.
 */
export const UNAUTHORIZED_EVENT = "routy:unauthorized";

export function signalUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
}
