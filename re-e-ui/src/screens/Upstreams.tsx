import { useMemo, useState } from "react";
import {
  useAddConnection,
  useConnections,
  useNodes,
  useRemoveNode,
  useResetBreaker,
  useTestNode,
} from "../api/hooks";
import type { NodeConnection, NodeStatus, UpstreamNode } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtMs } from "../utils/format";
import { ArrowsClockwise, Broadcast, CheckCircle, Plus, WifiHigh, XCircle } from "../components/icons";
import { NodeFormModal } from "../components/NodeFormModal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Drawer } from "../components/ui/Drawer";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Tabs } from "../components/ui/Tabs";
import { useToast } from "../components/ui/Toast";

const statusMeta: Record<
  NodeStatus,
  { badge: "success" | "warning" | "error" | "default"; label: string; dot: "green" | "yellow" | "red" | "gray" }
> = {
  healthy: { badge: "success", label: "healthy", dot: "green" },
  degraded: { badge: "warning", label: "degraded", dot: "yellow" },
  down: { badge: "error", label: "breaker open", dot: "red" },
  disabled: { badge: "default", label: "disabled", dot: "gray" },
};

const filterTabs = [
  { value: "all", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "degraded", label: "Degraded" },
  { value: "down", label: "Down" },
  { value: "disabled", label: "Disabled" },
];

function ConnectionsDrawer({ node, onClose }: { node: UpstreamNode | null; onClose: () => void }) {
  const toast = useToast();
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const connections = useConnections(node?.id ?? null);
  const addConnection = useAddConnection();

  const submit = () => {
    if (!node || !apiKey.trim()) return;
    addConnection.mutate(
      { nodeId: node.id, name: name.trim() || undefined, apiKey: apiKey.trim() },
      {
        onSuccess: () => {
          toast("Key added");
          setApiKey("");
          setName("");
        },
        onError: (err) => toastApiError(toast, err, "Failed to add key"),
      },
    );
  };

  return (
    <Drawer
      open={!!node}
      onClose={onClose}
      title={node ? `${node.name} · keys` : "keys"}
      subtitle={node && <span className="font-mono">{node.baseUrl}</span>}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {connections.isLoading && <Skeleton rows={2} />}
          {connections.data?.length === 0 && <p className="text-sm text-text-muted">No keys stored for this node.</p>}
          {connections.data?.map((c: NodeConnection) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-main">{c.name || "key"}</p>
                <p className="font-mono text-xs text-text-muted">{c.keyMasked}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
                {c.status && (
                  <Badge variant={c.status === "active" ? "success" : "default"} size="sm">
                    {c.status}
                  </Badge>
                )}
                {c.lastError && <span className="text-danger">{c.lastError}</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="h-px bg-border-subtle" />

        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-main">Add key</p>
          <Input label="Label" value={name} onChange={(e) => setName(e.target.value)} placeholder="primary" />
          <Input
            label="API Key"
            mono
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            hint="Plaintext is sent once and never returned by the API"
          />
          <div>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={14} />}
              disabled={!apiKey.trim()}
              loading={addConnection.isPending}
              onClick={submit}
            >
              Add Key
            </Button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

function NodeRow({ node, onKeys }: { node: UpstreamNode; onKeys: () => void }) {
  const toast = useToast();
  const testNode = useTestNode();
  const resetBreaker = useResetBreaker();
  const removeNode = useRemoveNode();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const meta = statusMeta[node.status];

  const runTest = () =>
    testNode.mutate(node.id, {
      onSuccess: (r) =>
        toast(
          r.ok ? `Test passed · ${r.latencyMs}ms · ${r.modelCount} models` : (r.error ?? "Test failed"),
          r.ok ? "success" : "error",
        ),
      onError: (err) => toastApiError(toast, err, "Test failed"),
    });

  return (
    <tr className="border-t border-border-subtle transition-colors hover:bg-surface-2/60">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <StatusDot tone={meta.dot} />
          <span className="text-sm font-medium text-text-main">{node.name}</span>
        </div>
      </td>
      <td className="px-4 py-2.5">
        <Badge variant={meta.badge} size="sm" dot>
          {meta.label}
        </Badge>
      </td>
      <td className="hidden max-w-[280px] px-4 py-2.5 lg:table-cell">
        <span className="block truncate font-mono text-xs text-text-muted">{node.baseUrl}</span>
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-text-muted">{node.prefix || "—"}</td>
      <td className="px-4 py-2.5 text-right font-mono text-xs tabular">
        {node.modelCount === 0 ? (
          <span className="text-text-subtle" title="Run Test to probe the model list">
            0
          </span>
        ) : (
          <span className="text-text-main">{node.modelCount}</span>
        )}
      </td>
      <td className="hidden px-4 py-2.5 text-right font-mono text-xs text-text-muted tabular sm:table-cell">
        {fmtMs(node.latencyMs)}
      </td>
      <td className="hidden px-4 py-2.5 font-mono text-xs text-text-muted xl:table-cell">{node.keyMasked}</td>
      <td className="px-4 py-2.5">
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="secondary" icon={<WifiHigh size={13} />} onClick={runTest} loading={testNode.isPending}>
            Test
          </Button>
          {node.status === "down" && (
            <Button
              size="sm"
              variant="ghost"
              icon={<ArrowsClockwise size={13} />}
              disabled={resetBreaker.isPending}
              onClick={() =>
                resetBreaker.mutate(node.id, {
                  onSuccess: () => toast("Breaker reset"),
                  onError: (err) => toastApiError(toast, err, "Reset failed"),
                })
              }
            >
              Reset
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onKeys}>
            Keys
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${node.name}`}
            className="hover:bg-danger/10 hover:text-danger"
            icon={<XCircle size={14} />}
            onClick={() => setConfirmRemove(true)}
          />
        </div>
      </td>

      <Modal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${node.name}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                removeNode.mutate(node.id, {
                  onSuccess: () => {
                    toast("Upstream removed");
                    setConfirmRemove(false);
                  },
                  onError: (err) => toastApiError(toast, err, "Remove failed"),
                })
              }
            >
              Remove Upstream
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Requests routing to this node will fail until a replacement is added.
        </p>
      </Modal>
    </tr>
  );
}

export function Upstreams() {
  const nodes = useNodes();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [keysNode, setKeysNode] = useState<UpstreamNode | null>(null);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (nodes.data ?? []).filter((n) => {
      if (filter !== "all" && n.status !== filter) return false;
      if (!needle) return true;
      return `${n.name} ${n.baseUrl} ${n.prefix}`.toLowerCase().includes(needle);
    });
  }, [nodes.data, filter, search]);

  if (nodes.isError) {
    const message = nodes.error instanceof Error ? nodes.error.message : "";
    return (
      <Card className="flex flex-col items-center gap-3 py-16 text-center">
        <XCircle size={40} className="text-text-subtle" />
        <p className="text-sm text-text-muted">Gateway unreachable. {message}</p>
        <p className="text-xs text-text-subtle">
          Start it with <code className="font-mono text-text-main">re-e serve</code>, then Retry.
        </p>
        <Button variant="secondary" onClick={() => nodes.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  const total = nodes.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onChange={setFilter} items={filterTabs} size="sm" />
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, URL, prefix"
            className="w-56"
            inputClassName="h-8 py-0 text-xs"
          />
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
            Add Upstream
          </Button>
        </div>
      </div>

      <Card padding="none" className="overflow-hidden">
        {nodes.isLoading ? (
          <div className="p-4">
            <Skeleton rows={5} />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <Broadcast size={40} className="text-text-subtle" />
            <p className="text-sm text-text-muted">
              {total === 0 ? "No upstreams yet. Add one to start routing." : "No nodes match this filter."}
            </p>
            {total === 0 && (
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
                Add Upstream
              </Button>
            )}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-bg-alt text-left">
                <th className="px-4 py-2 text-xs font-medium text-text-muted">Node</th>
                <th className="px-4 py-2 text-xs font-medium text-text-muted">Status</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-text-muted lg:table-cell">Base URL</th>
                <th className="px-4 py-2 text-xs font-medium text-text-muted">Prefix</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-text-muted">Models</th>
                <th className="hidden px-4 py-2 text-right text-xs font-medium text-text-muted sm:table-cell">TTFT</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-text-muted xl:table-cell">Key</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((n) => (
                <NodeRow key={n.id} node={n} onKeys={() => setKeysNode(n)} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-center gap-2 px-1 text-xs text-text-subtle">
        <CheckCircle size={13} className="shrink-0" />
        Status is real breaker state: degraded = failures recorded, down = breaker open, disabled = node off.
      </div>

      <NodeFormModal isOpen={addOpen} onClose={() => setAddOpen(false)} />
      <ConnectionsDrawer node={keysNode} onClose={() => setKeysNode(null)} />
    </div>
  );
}
