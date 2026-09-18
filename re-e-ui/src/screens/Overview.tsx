import { useState } from "react";
import { Link } from "react-router-dom";
import { useFailures, useGateway, useNodes, useResetBreaker, useStats, useTestNode } from "../api/hooks";
import type { UpstreamNode } from "../api/types";
import { statusMeta } from "../utils/nodeStatus";
import { toastApiError } from "../utils/errors";
import { fmtClock, fmtMs, fmtTokens } from "../utils/format";
import { CopyChip } from "../components/CopyChip";
import { NodeFormModal } from "../components/NodeFormModal";
import { StatTile } from "../components/StatTile";
import { ArrowsClockwise, Broadcast, List, Plus } from "../components/icons";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { StatusDot } from "../components/ui/StatusDot";
import { useToast } from "../components/ui/Toast";

function HealthCard({ node, onRemove }: { node: UpstreamNode; onRemove: (node: UpstreamNode) => void }) {
  const toast = useToast();
  const testNode = useTestNode();
  const resetBreaker = useResetBreaker();
  const meta = statusMeta[node.status];

  return (
    <Card padding="sm" className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={meta.dot} />
        <span className="truncate text-sm font-semibold text-text-main">{node.name}</span>
        <Badge variant={meta.badge} size="sm" dot>
          {meta.label}
        </Badge>
        <button
          onClick={() =>
            testNode.mutate(node.id, {
              onSuccess: (r) =>
                toast(r.ok ? `Test passed · ${r.latencyMs}ms · ${r.modelCount} models` : (r.error ?? "Test failed"), r.ok ? "success" : "error"),
              onError: (err) => toastApiError(toast, err, "Test failed"),
            })
          }
          className="ml-auto shrink-0 rounded-[6px] border border-border px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:border-brand-500/40 hover:text-text-main"
        >
          {testNode.isPending ? "Testing" : "Test"}
        </button>
      </div>

      <div className="truncate font-mono text-[11px] text-text-muted">{node.baseUrl}</div>

      <div className="flex items-center gap-3 font-mono text-[11px] text-text-muted tabular">
        <span>{fmtMs(node.latencyMs)}</span>
        <span>{node.modelCount === 0 ? "0 models" : `${node.modelCount} models`}</span>
        <span className="ml-auto">{node.keyMasked}</span>
      </div>

      {node.lastError && <p className="truncate font-mono text-[11px] text-danger">{node.lastError}</p>}

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
          Reset Breaker
        </Button>
      )}

      <button onClick={() => onRemove(node)} className="self-start text-[11px] text-text-subtle underline decoration-border underline-offset-2 transition-colors hover:text-danger">
        Manage in Upstreams
      </button>
    </Card>
  );
}

export function Overview() {
  const nodes = useNodes();
  const stats = useStats();
  const failures = useFailures(5);
  const gateway = useGateway();
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<UpstreamNode | null>(null);

  const s = stats.data;
  const quiet = !!s && s.requestsToday === 0 && s.tokens7d === 0;
  const count = nodes.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Endpoint strip — read from GET /api/gateway, never hardcoded */}
      {gateway.data && (
        <Card padding="sm" className="flex flex-wrap items-center gap-3">
          <StatusDot tone={gateway.data.online ? "green" : "red"} pulse={gateway.data.online} />
          <span className="text-xs text-text-muted">Proxy endpoint</span>
          <CopyChip value={gateway.data.endpoint} />
          <span className="text-xs text-text-muted">Router key</span>
          <CopyChip value={gateway.data.keyMasked} />
          <span className="ml-auto font-mono text-[10px] text-text-subtle">v{gateway.data.version}</span>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 sm:gap-4">
        <StatTile label="Requests · today" value={(s?.requestsToday ?? 0).toLocaleString()} loading={stats.isLoading} />
        <StatTile label="Tokens · 7d" value={fmtTokens(s?.tokens7d ?? 0)} loading={stats.isLoading} />
        <StatTile label="Cost · 7d" value={`$${(s?.costUsd7d ?? 0).toFixed(4)}`} loading={stats.isLoading} />
        <StatTile label="Error rate · 7d" value={`${(s?.errorRatePct ?? 0).toFixed(1)}%`} loading={stats.isLoading} />
        <StatTile
          label="TTFT · p50"
          value={s && s.ttftP50Ms > 0 ? `${s.ttftP50Ms}ms` : "—"}
          sub={s && s.ttftP50Ms === 0 ? "no successful probe yet" : undefined}
          loading={stats.isLoading}
        />
      </div>

      {/* Upstream health */}
      <section className="flex flex-col gap-3 sm:gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-main">Upstream health</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-muted tabular">{count} nodes</span>
            <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
              Add Upstream
            </Button>
          </div>
        </div>

        {nodes.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 sm:gap-4">
            {[0, 1, 2].map((i) => (
              <Card key={i} padding="sm" className="h-[118px]" />
            ))}
          </div>
        ) : count === 0 ? (
          <Card padding="lg" className="flex flex-col items-center justify-center gap-3 text-center">
            <Broadcast size={40} className="text-text-subtle" />
            <p className="text-sm text-text-muted">No upstreams yet. Add one to start routing.</p>
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
              Add Upstream
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 sm:gap-4">
            {nodes.data?.map((n) => (
              <HealthCard key={n.id} node={n} onRemove={setPendingRemove} />
            ))}
          </div>
        )}
      </section>

      {/* Recent failures */}
      {failures.data && failures.data.length > 0 && (
        <section className="flex flex-col gap-3 sm:gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-main">Recent Failures</h2>
            <Link to="/usage?tab=details" className="text-[11px] text-text-muted underline decoration-border underline-offset-2 hover:text-primary">
              All requests
            </Link>
          </div>
          <Card padding="none" className="overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-alt text-left">
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Time</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Node</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Error</th>
                  <th className="hidden px-4 py-2 text-xs font-medium text-text-muted sm:table-cell">Request</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs tabular">
                {failures.data.map((f) => (
                  <tr key={f.id} className="border-t border-border-subtle">
                    <td className="px-4 py-2 text-text-muted">{fmtClock(f.at)}</td>
                    <td className="px-4 py-2 text-text-main">{f.nodeName}</td>
                    <td className="px-4 py-2">
                      <Badge variant={f.errorCode === "rate_limited" ? "warning" : "error"} size="sm">
                        {f.errorCode}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-2 text-text-muted sm:table-cell">#{f.requestId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      {count > 0 && quiet && (
        <p className="text-xs text-text-subtle">
          Gateway is up and routed nothing yet — send one request through{" "}
          <span className="font-mono text-text-main">/v1/chat/completions</span>.
        </p>
      )}

      <NodeFormModal isOpen={addOpen} onClose={() => setAddOpen(false)} />

      <Modal
        isOpen={!!pendingRemove}
        onClose={() => setPendingRemove(null)}
        title={pendingRemove ? `Manage ${pendingRemove.name}?` : "manage"}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingRemove(null)}>
              Cancel
            </Button>
            <Link to="/upstreams">
              <Button variant="primary" icon={<List size={14} />}>
                Open Upstreams
              </Button>
            </Link>
          </>
        }
      >
        <p className="text-sm text-text-muted">Removal is handled on the Upstreams screen, where the node's keys live.</p>
      </Modal>
    </div>
  );
}
