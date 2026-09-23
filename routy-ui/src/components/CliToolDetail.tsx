import { useState } from "react";
import { useCliTools, useConnectCliTool, useDisconnectCliTool, useGateway, useKeys } from "../api/hooks";
import type { CliTool } from "../api/types";
import { toastApiError } from "../utils/errors";
import { ModelPicker } from "./ModelPicker";
import { TerminalWindow } from "./icons";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";

/**
 * The settings view for one CLI tool: which model it should ask for, which client
 * key it authenticates with, and what will be written where.
 *
 * Split out from the list so choosing a model has room — the list is for picking a
 * tool, this is for configuring it.
 */
export function CliToolDetail({ tool, onClose }: { tool: CliTool | null; onClose: () => void }) {
  const toast = useToast();
  const gateway = useGateway();
  const keys = useKeys();
  const tools = useCliTools();
  const connect = useConnectCliTool();
  const disconnect = useDisconnectCliTool();

  const [model, setModel] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string>("");
  const [confirming, setConfirming] = useState(false);

  // Always render from the freshest copy, so the modal reflects a connect that just
  // happened rather than the snapshot the card was clicked with.
  const live = tool ? (tools.data?.tools.find((t) => t.id === tool.id) ?? tool) : null;
  if (!live) return null;

  const endpoint = gateway.data?.endpoint ?? "";
  const usableKeys = (keys.data ?? []).filter((k) => k.enabled && k.key);
  const chosenKey = usableKeys.find((k) => k.id === keyId) ?? usableKeys[0] ?? null;

  const doConnect = () =>
    connect.mutate(
      { id: live.id, input: { apiKey: chosenKey?.key ?? null, model } },
      {
        onSuccess: () => toast(`${live.name} now points at routy`),
        onError: (err) => toastApiError(toast, err, `Failed to connect ${live.name}`),
      },
    );

  return (
    <Modal
      isOpen={!!tool}
      onClose={onClose}
      title={live.name}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {live.writable && (
            <Button variant="primary" loading={connect.isPending} disabled={!chosenKey} onClick={doConnect}>
              {live.connected ? "Reconnect with these settings" : "Connect to routy"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* what this tool is and where it lives */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <TerminalWindow size={15} className="text-text-muted" />
            {!live.installed ? (
              <Badge variant="default" size="sm">not installed</Badge>
            ) : live.connected ? (
              <Badge variant="success" size="sm">connected</Badge>
            ) : (
              <Badge variant="default" size="sm">available</Badge>
            )}
            {live.managed && <Badge variant="info" size="sm">written by routy</Badge>}
            {live.format && <Badge variant="default" size="sm">{live.format}</Badge>}
          </div>
          {live.configPath && (
            <p className="break-all font-mono text-[11px] text-text-subtle">{live.configPath}</p>
          )}
          {live.baseUrl && (
            <p className="break-all font-mono text-[11px] text-text-muted">currently → {live.baseUrl}</p>
          )}
          {live.note && <p className="text-[11px] text-text-muted">{live.note}</p>}
        </div>

        {!live.writable ? (
          <p className="text-xs text-text-muted">
            This tool has no local config to point at routy — it takes its endpoint from elsewhere.
          </p>
        ) : (
          <>
            {/* model */}
            <div className="flex flex-col gap-2">
              <div>
                <h4 className="text-xs font-semibold text-text-main">Model</h4>
                <p className="text-[11px] text-text-muted">
                  Which model this tool should request. Leave unset to let it choose, or to
                  keep whatever it currently uses.
                </p>
              </div>
              <ModelPicker value={model} onChange={setModel} />
            </div>

            {/* key */}
            <div className="flex flex-col gap-2">
              <div>
                <h4 className="text-xs font-semibold text-text-main">Client key</h4>
                <p className="text-[11px] text-text-muted">
                  The credential the tool sends to routy. Create one on Overview if the list is empty.
                </p>
              </div>
              {usableKeys.length === 0 ? (
                <p className="text-xs text-warning">No usable client keys — create one on the Overview page.</p>
              ) : (
                <select
                  value={chosenKey?.id ?? ""}
                  onChange={(e) => setKeyId(e.target.value)}
                  className="w-full rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-xs text-text-main"
                >
                  {usableKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name ?? k.id.slice(0, 8)} — {k.key?.slice(0, 7)}…
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* what will be written */}
            <div className="rounded-[8px] border border-border-subtle bg-surface-2/50 p-3">
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                What will be written
              </h4>
              <dl className="flex flex-col gap-0.5 font-mono text-[11px]">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-text-subtle">endpoint</dt>
                  <dd className="break-all text-text-main">{endpoint || "—"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-text-subtle">key</dt>
                  <dd className="text-text-main">{chosenKey ? `${chosenKey.name ?? "key"} — ${chosenKey.key?.slice(0, 7)}…` : "—"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-text-subtle">model</dt>
                  <dd className="break-all text-text-main">{model ?? "(unchanged)"}</dd>
                </div>
              </dl>
            </div>

            {live.managed && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
                <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
                  Disconnect and restore
                </Button>
                <span className="text-[11px] text-text-subtle">
                  Puts back exactly the values routy wrote.
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        title={`Disconnect ${live.name}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() =>
                disconnect.mutate(live.id, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast(`${live.name} restored`);
                  },
                  onError: (err) => {
                    setConfirming(false);
                    toastApiError(toast, err, "Disconnect failed");
                  },
                })
              }
            >
              Restore the file
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Puts back exactly the values routy wrote, and removes the ones that were not there
          before. Anything else you have changed in that file is left alone.
        </p>
      </Modal>
    </Modal>
  );
}
