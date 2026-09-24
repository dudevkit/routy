import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  useNodes,
  useRemoveNode,
  useTestAllKeys,
  useUpdateNode,
} from "../api/hooks";
import type { NodeStatus, UpstreamNode } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtMs } from "../utils/format";
import { Broadcast, CaretRight, Check, CheckCircle, Plus, Prohibit, WifiHigh, XCircle } from "../components/icons";
import { NodeFormModal } from "../components/NodeFormModal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
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

/**
 * A row is for scanning and navigating; the detail page is for doing. The only
 * inline action that still makes sense at list level is probing every key at once.
 */
function NodeRow({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const navigate = useNavigate();
  const testAll = useTestAllKeys();
  const updateNode = useUpdateNode();
  const removeNode = useRemoveNode();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const meta = statusMeta[node.status];
  const disabled = node.status === "disabled";

  const open = () => navigate(`/upstreams/${node.id}`);

  return (
    <tr
      onClick={open}
      className="cursor-pointer border-t border-border-subtle transition-colors hover:bg-surface-2/60"
    >
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <StatusDot tone={meta.dot} />
          <Link
            to={`/upstreams/${node.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-medium text-text-main hover:text-primary hover:underline"
          >
            {node.name}
          </Link>
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
          <span className="text-text-subtle" title="Open the provider to import or add models">
            0
          </span>
        ) : (
          <span className="text-text-main">{node.modelCount}</span>
        )}
      </td>
      <td className="hidden px-4 py-2.5 text-right font-mono text-xs text-text-muted tabular md:table-cell">
        {fmtMs(node.latencyMs)}
      </td>
      <td className="hidden px-4 py-2.5 font-mono text-xs text-text-muted xl:table-cell">{node.keyMasked}</td>
      {/* Below md the whole row is the tap target (it navigates), so the mutating
          actions — all of which exist on the provider page — give up their 278px. */}
      <td className="hidden px-4 py-2.5 md:table-cell" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="secondary"
            icon={<WifiHigh size={13} />}
            loading={testAll.isPending}
            onClick={() =>
              testAll.mutate(
                { nodeId: node.id },
                {
                  onSuccess: (r) => toast(`${r.ok}/${r.tested} keys ok`, r.ok === r.tested ? "success" : "error"),
                  onError: (err) => toastApiError(toast, err, "Key test failed"),
                },
              )
            }
          >
            Test keys
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={disabled ? `Enable ${node.name}` : `Disable ${node.name}`}
            icon={disabled ? <Check size={13} /> : <Prohibit size={13} />}
            disabled={updateNode.isPending}
            onClick={() =>
              updateNode.mutate(
                { id: node.id, patch: { enabled: disabled } },
                {
                  onSuccess: () => toast(disabled ? "Provider enabled" : "Provider disabled"),
                  onError: (err) => toastApiError(toast, err, disabled ? "Failed to enable" : "Failed to disable"),
                },
              )
            }
          >
            {disabled ? "Enable" : "Disable"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${node.name}`}
            className="hover:bg-danger/10 hover:text-danger"
            icon={<XCircle size={14} />}
            onClick={() => setConfirmRemove(true)}
          />
          <Button size="sm" variant="ghost" icon={<CaretRight size={13} />} aria-label={`Manage ${node.name}`} onClick={open} />
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
                    toast("Provider removed");
                    setConfirmRemove(false);
                  },
                  onError: (err) => toastApiError(toast, err, "Remove failed"),
                })
              }
            >
              Remove Provider
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Removes the provider, its API keys and its model list. Requests routing to
          <span className="font-mono"> {node.prefix}/…</span> will stop resolving.
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
          Start it with <code className="font-mono text-text-main">routy serve</code>, then Retry.
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
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, URL, prefix"
            className="w-full min-w-0 sm:w-56"
            inputClassName="h-8 py-0 text-xs"
          />
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
            Add Provider
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
              {total === 0 ? "No providers yet. Add one to start routing." : "No providers match this filter."}
            </p>
            {total === 0 && (
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
                Add Provider
              </Button>
            )}
          </div>
        ) : (
          <div className="w-full min-w-0 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-alt text-left">
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Node</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Status</th>
                  <th className="hidden px-4 py-2 text-xs font-medium text-text-muted lg:table-cell">Base URL</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Prefix</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-text-muted">Models</th>
                  <th className="hidden px-4 py-2 text-right text-xs font-medium text-text-muted md:table-cell">TTFT</th>
                  <th className="hidden px-4 py-2 text-xs font-medium text-text-muted xl:table-cell">Key</th>
                  <th className="hidden px-4 py-2 text-right text-xs font-medium text-text-muted md:table-cell">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((n) => (
                  <NodeRow key={n.id} node={n} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="flex items-center gap-2 px-1 text-xs text-text-subtle">
        <CheckCircle size={13} className="shrink-0" />
        Status is real breaker state: degraded = failures recorded, down = breaker open, disabled = provider off.
      </div>

      <NodeFormModal
        isOpen={addOpen}
        node={null}
        onClose={() => setAddOpen(false)}
      />
    </div>
  );
}
