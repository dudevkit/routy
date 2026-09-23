import { useState } from "react";
import { useCliTools, useConnectCliTool, useDisconnectCliTool, useGateway, useKeys } from "../api/hooks";
import type { CliTool } from "../api/types";
import { toastApiError } from "../utils/errors";
import { TerminalWindow } from "../components/icons";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { useToast } from "../components/ui/Toast";

/**
 * Point a locally installed CLI at this gateway.
 *
 * Writing into someone's Claude or Codex config is a real edit, so the card always
 * shows the exact file, what it currently points at, and — once routy has written
 * it — offers a Disconnect that puts the file back the way it was found.
 */
function ToolCard({ tool }: { tool: CliTool }) {
  const toast = useToast();
  const gateway = useGateway();
  const keys = useKeys();
  const connect = useConnectCliTool();
  const disconnect = useDisconnectCliTool();
  const [confirming, setConfirming] = useState(false);
  const [keyId, setKeyId] = useState<string>("");

  const endpoint = gateway.data?.endpoint ?? "";
  const usableKeys = (keys.data ?? []).filter((k) => k.enabled && k.key);
  const chosenKey = usableKeys.find((k) => k.id === keyId) ?? usableKeys[0] ?? null;
  // "connected" is to *some* gateway; ours is a stronger claim.
  const pointsHere = !!tool.baseUrl && !!endpoint && tool.baseUrl.replace(/\/+$/, "") === endpoint.replace(/\/+$/, "");

  const doConnect = () =>
    connect.mutate(
      { id: tool.id, input: { apiKey: chosenKey?.key ?? null } },
      {
        onSuccess: () => toast(`${tool.name} now points at routy`),
        onError: (err) => toastApiError(toast, err, `Failed to connect ${tool.name}`),
      },
    );

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <TerminalWindow size={16} className="text-text-muted" />
        <h3 className="text-sm font-semibold text-text-main">{tool.name}</h3>
        {!tool.installed ? (
          <Badge variant="default" size="sm">not installed</Badge>
        ) : pointsHere ? (
          <Badge variant="success" size="sm">connected</Badge>
        ) : tool.connected ? (
          <Badge variant="warning" size="sm">points elsewhere</Badge>
        ) : (
          <Badge variant="default" size="sm">available</Badge>
        )}
        {tool.managed && (
          <Badge variant="info" size="sm" >written by routy</Badge>
        )}
      </div>

      <div className="flex flex-col gap-1 font-mono text-[11px] text-text-subtle">
        <span className="truncate" title={tool.configPath}>{tool.configPath}</span>
        <span className="truncate">
          {tool.baseUrl ? `→ ${tool.baseUrl}` : "→ not pointed at a gateway"}
        </span>
      </div>

      {tool.note && <p className="text-[11px] text-text-muted">{tool.note}</p>}

      {tool.installed && (
        <div className="flex flex-wrap items-center gap-2">
          {!tool.writable ? (
            <span className="text-[11px] text-text-muted">
              No local config to point at routy — this tool takes its endpoint from elsewhere.
            </span>
          ) : tool.managed ? (
            <Button variant="secondary" size="sm" loading={disconnect.isPending} onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          ) : usableKeys.length === 0 ? (
            <span className="text-[11px] text-text-muted">
              Create a client key on Overview first — the tool needs one to authenticate.
            </span>
          ) : (
            <>
              {usableKeys.length > 1 && (
                <select
                  value={chosenKey?.id ?? ""}
                  onChange={(e) => setKeyId(e.target.value)}
                  className="rounded-[6px] border border-border-subtle bg-bg px-2 py-1 font-mono text-xs text-text-main"
                >
                  {usableKeys.map((k) => (
                    <option key={k.id} value={k.id}>{k.name ?? k.id.slice(0, 8)}</option>
                  ))}
                </select>
              )}
              <Button variant="primary" size="sm" loading={connect.isPending} onClick={doConnect}>
                Connect to routy
              </Button>
            </>
          )}
        </div>
      )}

      <Modal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        title={`Disconnect ${tool.name}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() =>
                disconnect.mutate(tool.id, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast(`${tool.name} restored`);
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
          Puts back exactly the values routy wrote, and removes the ones that were not
          there before. Anything else you have changed in that file is left alone.
        </p>
      </Modal>
    </Card>
  );
}

export function CliTools() {
  const tools = useCliTools();
  const list = tools.data?.tools ?? [];
  const detected = list.filter((t) => t.installed);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-text-main">CLI Tools</h1>
        <p className="text-xs text-text-muted">
          Point an AI CLI installed on this machine at routy. Detection reads your PATH and
          config files; nothing is written until you press Connect.
        </p>
      </div>

      {tools.isLoading ? (
        <Skeleton rows={3} />
      ) : detected.length === 0 ? (
        <Card padding="sm" className="flex flex-col items-center gap-3 py-12 text-center">
          <TerminalWindow size={28} className="text-text-subtle" />
          <p className="text-sm text-text-muted">No supported CLI tools found on this machine.</p>
          <p className="max-w-md text-xs text-text-subtle">
            routy looks for each tool's binary on your PATH and for its config file in your
            home directory. Install one and reload.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {detected.map((t) => (
            <ToolCard key={t.id} tool={t} />
          ))}
        </div>
      )}

      {!tools.isLoading && list.length > detected.length && (
        <p className="text-[11px] text-text-subtle">
          {list.length - detected.length} other supported tool
          {list.length - detected.length === 1 ? "" : "s"} not installed here.
        </p>
      )}
    </div>
  );
}
