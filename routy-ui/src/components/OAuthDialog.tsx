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
  /** create = first account; add = another account on nodeId; reconnect = replace connectionId */
  intent: { kind: "create" } | { kind: "add"; nodeId: string; nodeName: string } | { kind: "reconnect"; connectionId: string; accountLabel: string };
  onConnected?: () => void;
}

export function OAuthDialog({ isOpen, onClose, intent, onConnected }: OAuthDialogProps) {
  const toast = useToast();
  const invalidate = useInvalidator(NODES, CONNECTIONS);
  const [phase, setPhase] = useState<Phase>("form");
  const [name, setName] = useState("CodeBuddy");
  const [prefix, setPrefix] = useState("cbai");
  const [accountLabel, setAccountLabel] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { window.clearTimeout(pollRef.current); pollRef.current = null; }
  }, []);

  // Reset whenever the dialog opens for a fresh intent.
  useEffect(() => {
    if (isOpen) {
      setPhase("form"); setFlowId(null); setVerificationUrl(null); setError(null); cancelledRef.current = false;
    } else {
      stopPolling();
    }
  }, [isOpen, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const handleResult = useCallback((result: OAuthFlowResult) => {
    if (result.state === "complete") {
      setPhase("done");
      invalidate();
      toast(intent.kind === "reconnect" ? "Account reconnected" : "CodeBuddy account connected");
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
      const result = await api.oauthPoll(id);
      if (cancelledRef.current) return;
      if (result.state === "pending") {
        pollRef.current = window.setTimeout(() => pollOnce(id, intervalMs), intervalMs);
      } else {
        handleResult(result);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      // A transient poll error should not kill the flow — keep trying on the same cadence.
      pollRef.current = window.setTimeout(() => pollOnce(id, intervalMs), intervalMs);
    }
  }, [handleResult]);

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
      const flow = await api.oauthStart(payload);
      setFlowId(flow.flowId);
      setVerificationUrl(flow.verificationUrl);
      setPhase("waiting");
      pollRef.current = window.setTimeout(() => pollOnce(flow.flowId, Math.max(4000, flow.pollIntervalMs)), flow.pollIntervalMs);
    } catch (err) {
      toastApiError(toast, err, "Could not start the login flow");
      setError(err instanceof Error ? err.message : "Could not start the login flow");
    }
  }, [accountLabel, intent, name, pollOnce, prefix, toast]);

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    stopPolling();
    if (flowId) {
      try {
        const result = await api.oauthCancel(flowId);
        handleResult(result); // a commit that already won reports success here
        return;
      } catch { /* fall through to a local cancel view */ }
    }
    setPhase("cancelled");
  }, [flowId, handleResult, stopPolling]);

  const title = intent.kind === "create" ? "Connect WorkBuddy" : intent.kind === "add" ? `Add account to ${intent.nodeName}` : `Reconnect ${intent.accountLabel}`;

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
              A browser tab opens on <span className="font-mono">www.workbuddy.ai</span> where you sign in. Keep this
              dialog open — it finishes automatically once you are back.
            </p>
            {intent.kind === "create" && (
              <>
                <Input label="Provider name" value={name} onChange={(e) => setName(e.target.value)} required />
                <Input label="Model prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} required hint="Used as prefix/model — for example cbai/glm-5.2" />
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
                Open the CodeBuddy login page →
              </a>
            )}
            <p className="text-xs text-text-subtle">If the tab did not open, use the link above.</p>
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
