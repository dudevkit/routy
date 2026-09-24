import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";
import { fetchAuthState, login, onUnauthorized, type AuthState } from "../api/auth";
import { Key } from "./icons";
import { SecurityBanner } from "./SecurityBanner";

/**
 * The dashboard login.
 *
 * Asked for once per browser: the server sets an HttpOnly session cookie, so this
 * appears the first time you open the dashboard from a device and never again on that
 * device. Loopback is trusted, so the dashboard on the gateway's own machine is never
 * asked to sign in to itself.
 *
 * The default password is 123456, the way a router's admin page ships with one. It
 * keeps the gateway reachable from anywhere without a setup step while still refusing
 * anonymous access — and Settings says plainly when it is still the default.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchAuthState().then((next) => {
      if (alive) setState(next);
    });
    // The session can expire or be invalidated (the signing key was rotated). The
    // transport raises this rather than every screen rendering its own failure.
    return onUnauthorized(() => {
      if (alive) setState((prev) => (prev ? { ...prev, authed: false } : prev));
    });
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    const result = await login(password);
    if (result.ok) {
      setPassword("");
      setState(await fetchAuthState());
    } else {
      setError(result.detail ?? "Incorrect password.");
    }
    setBusy(false);
  };

  if (!state) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-bg">
        <span className="text-xs text-text-subtle">connecting…</span>
      </div>
    );
  }

  if (!state.authed) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-bg p-6">
        <Card className="w-full max-w-sm p-6">
          <div className="mb-4 flex items-center gap-3">
            <Key size={22} className="text-text-subtle" />
            <h1 className="text-sm font-medium text-text">Sign in to routy</h1>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-text-muted">
            This gateway is reachable on the network, so its dashboard needs a password.
            You will only be asked once on this device.
          </p>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              autoFocus
              autoComplete="current-password"
              aria-label="dashboard password"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <Button type="submit" disabled={busy || !password}>
              {busy ? "checking…" : "Sign in"}
            </Button>
          </form>
          {state.passwordIsDefault && (
            <p className="mt-4 text-[11px] leading-relaxed text-text-subtle">
              Still on the default password: <code className="text-text-muted">123456</code>. Change it
              in Settings once you are in.
            </p>
          )}
        </Card>
      </div>
    );
  }

  return (
    <>
      {state.unlockedNetwork && <SecurityBanner />}
      {children}
    </>
  );
}
