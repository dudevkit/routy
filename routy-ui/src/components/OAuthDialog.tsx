// CodeBuddy Intl OAuth onboarding + account management.
//
// Three intents share one dialog: create a first account (asks for a node name + prefix),
// add another account to an existing node, or reconnect one row. The flow keeps the opaque
// local `flowId` in component memory only; the upstream state never reaches the browser.
//
// The login link is a real anchor the operator clicks (not a `window.open` after an await,
// which browsers block), and polling is a server-paced POST loop. Cancel is explicit, and a
// commit that wins the documented race is reported as success, not a false cancellation.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useInvalidator, NODES, CONNECTIONS } from "../api/hooks";
import type { OAuthFlowResult, OAuthIntent } from "../api/types";
import { toastApiError } from "../utils/errors";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";

type Phase = "form" | "waiting" | "done" | "failed" | "cancelled";

export interface OAuthDialogProps {
  isOpen: boolean;
  onClose: () => void;
  providerId?: string;
  providerName?: string;
  defaultPrefix?: string;
  /** create = first account; add = another account on nodeId; reconnect = replace connectionId */
  intent: { kind: "create" } | { kind: "add"; nodeId: string; nodeName: string } | { kind: "reconnect"; connectionId: string; accountLabel: string };
  onConnected?: () => void;
}

export function OAuthDialog({ isOpen, onClose, intent, onConnected, providerId = "codebuddy-intl", providerName = "CodeBuddy", defaultPrefix = "cbai" }: OAuthDialogProps) {
  const toast = useToast();
  const invalidate = useInvalidator(NODES, CONNECTIONS);
  const [phase, setPhase] = useState<Phase>("form");
  const [name, setName] = useState(providerName);
  const [prefix, setPrefix] = useState(defaultPrefix);
  const [accountLabel, setAccountLabel] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { window.clearTimeout(pollRef.current); pollRef.current = null; }
  }, []);

  // Reset whenever the dialog opens for a fresh intent.
  useEffect(() => {
    if (isOpen) {
      setPhase("form"); setFlowId(null); setVerificationUrl(null); setError(null); setManualCode(""); cancelledRef.current = false;
      setName(providerName); setPrefix(defaultPrefix);
    } else {
      stopPolling();
    }
  }, [isOpen, providerName, defaultPrefix, stopPolling]);
  useEffect(() => stopPolling, [stopPolling]);

  const handleResult = useCallback((result: OAuthFlowResult) => {
    if (result.state === "complete") {
      setPhase("done");
      invalidate();
      toast(intent.kind === "reconnect" ? "Account reconnected" : `${providerName} account connected`);
      onConnected?.();
    } else if (result.state === "cancelled") {
      setPhase("cancelled");
    } else if (result.state === "failed") {
      setError(result.error.message);
      setPhase("failed");
    }
  }, [invalidate, intent.kind, onConnected, toast]);

  const pollOnce = useCallback(async (id: string, intervalMs: number) => {
    try {
      const result = await api.oauthPoll(id, providerId);
      if (cancelledRef.current) return;
      if (result.state === "pending") {
        pollRef.current = window.setTimeout(() => pollOnce(id, intervalMs), intervalMs);
      } else {
        handleResult(result);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      pollRef.current = window.setTimeout(() => pollOnce(id, intervalMs), intervalMs);
    }
  }, [handleResult, providerId]);

  useEffect(() => {
    const handleMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "oauth_callback" && ev.data?.data?.code && flowId) {
        api.oauthCallback(flowId, ev.data.data.code, providerId).then(handleResult).catch(() => {});
      }
    };
    window.addEventListener("message", handleMsg);
    return () => window.removeEventListener("message", handleMsg);
  }, [flowId, handleResult, providerId]);

  const start = useCallback(async () => {
    setError(null);
    let payload: OAuthIntent;
    if (intent.kind === "create") {
      if (!name.trim() || !prefix.trim()) { setError("A name and a prefix are required."); return; }
      payload = { intent: "create", name: name.trim(), prefix: prefix.trim(), accountLabel: accountLabel.trim() || undefined };
    } else if (intent.kind === "add") {
      payload = { intent: "add", nodeId: intent.nodeId, accountLabel: accountLabel.trim() || undefined };
    } else {
      payload = { intent: "reconnect", connectionId: intent.connectionId, accountLabel: accountLabel.trim() || undefined };
    }
    try {
      const flow = await api.oauthStart(payload, providerId);
      setFlowId(flow.flowId);
      setVerificationUrl(flow.verificationUrl);
      setPhase("waiting");
      pollRef.current = window.setTimeout(() => pollOnce(flow.flowId, Math.max(2500, flow.pollIntervalMs)), flow.pollIntervalMs);
    } catch (err) {
      toastApiError(toast, err, "Could not start the login flow");
      setError(err instanceof Error ? err.message : "Could not start the login flow");
    }
  }, [accountLabel, intent, name, pollOnce, prefix, providerId, toast]);

  const submitManualCode = useCallback(async () => {
    if (!flowId || !manualCode.trim()) return;
    try {
      setError(null);
      const res = await api.oauthCallback(flowId, manualCode.trim(), providerId);
      handleResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Callback submission failed");
    }
  }, [flowId, handleResult, manualCode, providerId]);

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    stopPolling();
    if (flowId) {
      try {
        const result = await api.oauthCancel(flowId, providerId);
        handleResult(result);
        return;
      } catch { /* fall through to local cancel */ }
    }
    setPhase("cancelled");
  }, [flowId, handleResult, providerId, stopPolling]);

  const title = intent.kind === "create" ? `Connect ${providerName}` : intent.kind === "add" ? `Add account to ${intent.nodeName}` : `Reconnect ${intent.accountLabel}`;


  return (
    <Modal
      isOpen={isOpen}
      onClose={phase === "waiting" ? cancel : onClose}
      title={title}
      size="md"
      footer={
        phase === "form" ? (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={start}>Start login</Button>
          </>
        ) : phase === "waiting" ? (
          <Button variant="secondary" onClick={cancel}>Cancel</Button>
        ) : (
          <Button variant="primary" onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        {phase === "form" && (
          <>
            <p className="text-text-muted">
              A browser tab opens where you sign in to <span className="font-mono">{providerName}</span>. Keep this
              dialog open — it finishes automatically once you are back.
            </p>
            {intent.kind === "create" && (
              <>
                <Input label="Provider name" value={name} onChange={(e) => setName(e.target.value)} required />
                <Input label="Model prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} required hint={`Used as prefix/model — for example ${defaultPrefix}/model`} />
              </>
            )}
            {intent.kind !== "create" && (
              <Input label="Account label (optional)" value={accountLabel} onChange={(e) => setAccountLabel(e.target.value)} hint="A local name for this account — the provider returns no verified identity." />
            )}
          </>
        )}
        {phase === "waiting" && (
          <>
            <p className="text-text-muted">Waiting for you to finish signing in…</p>
            {verificationUrl && (
              <a
                href={verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-sm font-medium text-primary hover:underline"
              >
                Open {providerName} login page →
              </a>
            )}
            <p className="text-xs text-text-subtle">If the tab did not open automatically, click the link above.</p>
            {providerId === "antigravity" && (
              <div className="mt-2 flex flex-col gap-2 rounded border border-border-subtle bg-bg-alt p-3">
                <span className="text-xs text-text-muted">
                  If the callback did not redirect automatically, paste the redirect URL or authorization code here:
                </span>
                <div className="flex gap-2">
                  <Input
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    placeholder="Paste redirect URL (http://localhost:8010/callback?code=...) or code"
                    className="flex-1"
                  />
                  <Button size="sm" variant="secondary" onClick={submitManualCode} disabled={!manualCode.trim()}>
                    Submit
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
        {phase === "done" && <p className="text-text-muted">Account connected. Its models are available under the provider’s page.</p>}
        {phase === "cancelled" && <p className="text-text-muted">Login cancelled — nothing was saved.</p>}
        {phase === "failed" && <p className="text-danger">{error ?? "The login flow failed. Try again."}</p>}
        {phase === "form" && error && <p className="text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
