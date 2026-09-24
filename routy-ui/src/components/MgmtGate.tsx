import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";
import { getToken, onUnauthorized, setToken } from "../api/auth";
import { Key } from "./icons";

type GateState = "checking" | "open" | "locked";

/**
 * Asks for the management token when the dashboard is not being served from the
 * gateway's own machine.
 *
 * `/api` is open to loopback and requires a token from anywhere else. Without this,
 * opening the dashboard on a laptop against a gateway on a server renders the shell
 * and then nothing: every request 401s, so there is no version, no providers, and no
 * explanation. The gate is what turns that silence into one clear question.
 *
 * It renders children only once a token is known to work, so no screen ever mounts
 * against an API that will refuse it.
 */
export function MgmtGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Does the current situation need a token, and if we have one, does it work? */
  const evaluate = async (): Promise<GateState> => {
    try {
      const probe = await fetch("/api/auth");
      if (!probe.ok) return "open"; // probe unreachable — let the app surface it
      const body: unknown = await probe.json();
      const required = typeof body === "object" && body !== null && (body as { required?: unknown }).required === true;
      if (!required) return "open"; // loopback: /api is open

      const token = getToken();
      if (!token) return "locked";
      const check = await fetch("/api/version", { headers: { authorization: `Bearer ${token}` } });
      return check.ok ? "open" : "locked";
    } catch {
      return "open"; // a network failure is not an auth problem
    }
  };

  useEffect(() => {
    let alive = true;
    void evaluate().then((next) => {
      if (alive) setState(next);
    });
    // The token can be rejected at any time (rotated on the server). The transport
    // raises this instead of every screen rendering its own failure.
    return onUnauthorized(() => {
      if (alive) setState("locked");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    setToken(token);
    const next = await evaluate();
    setBusy(false);
    if (next === "open") {
      setValue("");
      setState("open");
    } else {
      setError("That token was not accepted. Check it against the server's boot log.");
    }
  };

  if (state === "checking") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-bg">
        <span className="text-xs text-text-subtle">connecting…</span>
      </div>
    );
  }

  if (state === "locked") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-bg p-6">
        <Card className="w-full max-w-md p-6">
          <div className="mb-4 flex items-center gap-3">
            <Key size={22} className="text-text-subtle" />
            <h1 className="text-sm font-medium text-text">Management token required</h1>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-text-muted">
            This gateway is listening on the network, so its management API needs the token it
            generated on first boot. Find it on the machine running routy:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-md bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
            journalctl -u routy | grep managementToken
          </pre>
          <p className="mb-4 text-xs leading-relaxed text-text-muted">
            It is stored in <code className="text-text-subtle">~/.routy/mgmt-token</code> and stays
            the same across restarts, so this is a one-time step for this browser.
          </p>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="paste the token"
              autoFocus
              aria-label="management token"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? "checking…" : "Connect"}
            </Button>
          </form>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
