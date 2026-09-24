/**
 * Management token, for using the dashboard from another device.
 *
 * `/api` is open to loopback and requires a token from anywhere else — which is
 * every time you open the dashboard on your laptop and the gateway is on your
 * server. The token lives in the state directory (`mgmt-token`) and is printed at
 * boot, so it survives restarts: store it once and the dashboard keeps working.
 *
 * It is a credential, not a session — the same token authenticates every request.
 * Kept in localStorage because the alternative (in memory) means re-entering it on
 * every page load, which is the annoyance this exists to remove.
 */
const STORAGE_KEY = "routy.mgmtToken";

export function getToken(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null; // private mode, or storage disabled
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token.trim());
  } catch {
    /* private mode — the token works for this page load only */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * The gateway rejected our token. Raised as an event rather than a callback so the
 * transport does not have to import the shell — the shell subscribes, and shows the
 * gate. Anything else would make client.ts depend on React.
 */
export const UNAUTHORIZED_EVENT = "routy:unauthorized";

export function signalUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
}
