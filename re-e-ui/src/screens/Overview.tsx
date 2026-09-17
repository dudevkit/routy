import { useState } from "react";
import {
  useAddNode,
  useFailures,
  useGateway,
  useNodes,
  useRemoveNode,
  useResetBreaker,
  useStats,
  useTestConnection,
  useTestNode,
} from "../api/hooks";
import type { NodeStatus, TestResult, UpstreamNode } from "../api/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { StatusDot } from "../components/ui/StatusDot";
import { useToast } from "../components/ui/Toast";

const statusBadge: Record<NodeStatus, { variant: "success" | "warning" | "error" | "default"; label: string }> = {
  healthy: { variant: "success", label: "healthy" },
  degraded: { variant: "warning", label: "degraded" },
  down: { variant: "error", label: "breaker open" },
  disabled: { variant: "default", label: "disabled" },
};

const dotTone: Record<NodeStatus, "green" | "yellow" | "red" | "gray"> = {
  healthy: "green",
  degraded: "yellow",
  down: "red",
  disabled: "gray",
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={`Copy ${value}`}
      className="inline-flex h-7 max-w-[280px] items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 text-xs font-mono text-text-main transition-colors hover:border-brand-500/40"
    >
      <span className="material-symbols-outlined shrink-0 text-[14px] text-text-muted">
        {copied ? "check" : "content_copy"}
      </span>
      <span className="truncate">{value}</span>
    </button>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card padding="sm">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{label}</span>
        <span className="font-mono text-xl font-semibold tabular">{value}</span>
        {sub && <span className="text-[10px] text-text-subtle">{sub}</span>}
      </div>
    </Card>
  );
}

function NodeCard({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const testNode = useTestNode();
  const resetBreaker = useResetBreaker();
  const removeNode = useRemoveNode();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const badge = statusBadge[node.status];

  const onTest = () =>
    testNode.mutate(node.id, {
      onSuccess: (r) => {
        toast(
          r.ok ? `Test passed · ${r.latencyMs}ms · ${r.modelCount} models` : (r.error ?? "Test failed"),
          r.ok ? "success" : "error",
        );
      },
    });

  return (
    <Card padding="sm" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={dotTone[node.status]} />
          <span className="truncate text-sm font-semibold text-text-main">{node.name}</span>
          <Badge variant={badge.variant} dot size="sm">
            {badge.label}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" onClick={onTest} loading={testNode.isPending}>
            {testNode.isPending ? "Testing" : "Test"}
          </Button>
          {node.status === "down" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                resetBreaker.mutate(node.id, {
                  onSuccess: () => toast("Breaker reset"),
                })
              }
              disabled={resetBreaker.isPending}
            >
              Reset Breaker
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${node.name}`}
            className="hover:bg-red-500/10 hover:text-red-500"
            icon="delete"
            onClick={() => setConfirmRemove(true)}
          />
        </div>
      </div>

      <div className="truncate font-mono text-xs text-text-muted">{node.baseUrl}</div>

      <div className="flex items-center gap-4 text-xs text-text-muted">
        <span className="font-mono tabular">{node.latencyMs == null ? "—" : `${node.latencyMs}ms`}</span>
        <span className="tabular">{node.modelCount} models</span>
        <span className="font-mono">{node.prefix ? `prefix ${node.prefix}` : "no prefix"}</span>
        <span className="ml-auto font-mono">{node.keyMasked}</span>
      </div>

      {node.lastError && <p className="font-mono text-xs text-red-500">{node.lastError}</p>}

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
              onClick={() => {
                removeNode.mutate(node.id, {
                  onSuccess: () => toast("Upstream removed"),
                });
                setConfirmRemove(false);
              }}
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
    </Card>
  );
}

type TestState = null | "testing" | TestResult;

const emptyForm = { name: "", baseUrl: "", apiKey: "", prefix: "" };

function AddUpstreamModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [test, setTest] = useState<TestState>(null);
  const testConnection = useTestConnection();
  const addNode = useAddNode();

  const close = () => {
    setForm(emptyForm);
    setTest(null);
    onClose();
  };

  const urlLooksValid = /^https?:\/\/.+/.test(form.baseUrl.trim());
  const canSave = form.name.trim().length > 0 && urlLooksValid;

  const runTest = () => {
    setTest("testing");
    testConnection.mutate(
      { baseUrl: form.baseUrl },
      {
        onSuccess: (r) => setTest(r),
        onError: () => setTest({ ok: false, error: "Node unreachable. Check baseUrl and network." }),
      },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Add Upstream"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="add"
            disabled={!canSave || addNode.isPending}
            loading={addNode.isPending}
            onClick={() =>
              addNode.mutate(form, {
                onSuccess: () => {
                  toast("Upstream added");
                  close();
                },
              })
            }
          >
            {addNode.isPending ? "Adding" : "Add Upstream"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          autoFocus
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="My upstream"
        />
        <Input
          label="Base URL"
          mono
          value={form.baseUrl}
          onChange={(e) => {
            setForm({ ...form, baseUrl: e.target.value });
            setTest(null);
          }}
          placeholder="https://api.example.com/v1"
        />
        <Input
          label="API Key"
          mono
          type="password"
          value={form.apiKey}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          placeholder="sk-…"
        />
        <Input
          label="Model Prefix"
          mono
          hint="Optional · models with this prefix route to the node"
          value={form.prefix}
          onChange={(e) => setForm({ ...form, prefix: e.target.value })}
          placeholder="or/"
        />

        <div className="flex min-h-7 items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            icon="network_check"
            disabled={!urlLooksValid || test === "testing"}
            onClick={runTest}
          >
            {test === "testing" ? "Testing" : "Test Connection"}
          </Button>
          {test && test !== "testing" &&
            (test.ok ? (
              <span className="flex items-center gap-1.5 font-mono text-xs text-green-600 dark:text-green-400 tabular">
                <span className="material-symbols-outlined text-[14px]">check_circle</span>
                200 · {test.latencyMs}ms · {test.modelCount} models
              </span>
            ) : (
              <span className="text-xs text-red-500">{test.error}</span>
            ))}
        </div>
      </div>
    </Modal>
  );
}

export function Overview() {
  const nodes = useNodes();
  const stats = useStats();
  const failures = useFailures();
  const gateway = useGateway();
  const [addOpen, setAddOpen] = useState(false);

  const addButton = (
    <Button variant="primary" icon="add" onClick={() => setAddOpen(true)}>
      Add Upstream
    </Button>
  );

  return (
    <div className="flex flex-col gap-6 px-1 sm:px-0">
      {/* Endpoint strip */}
      {gateway.data && (
        <Card padding="sm" className="flex items-center gap-3">
          <StatusDot tone={gateway.data.online ? "green" : "red"} pulse={gateway.data.online} />
          <span className="text-xs text-text-muted">Proxy endpoint</span>
          <CopyChip value={gateway.data.endpoint} />
          <span className="text-xs text-text-muted">API key</span>
          <CopyChip value={gateway.data.keyMasked} />
          <span className="ml-auto font-mono text-[10px] text-text-subtle">v{gateway.data.version}</span>
        </Card>
      )}

      {/* Stats */}
      {stats.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 sm:gap-4">
          <StatCard label="Requests · today" value={stats.data.requestsToday.toLocaleString()} />
          <StatCard label="Tokens · 7d" value={fmtTokens(stats.data.tokens7d)} />
          <StatCard label="Cost · 7d" value={`$${stats.data.costUsd7d.toFixed(2)}`} />
          <StatCard label="Error rate" value={`${stats.data.errorRatePct.toFixed(1)}%`} />
          <StatCard label="TTFT · p50" value={`${stats.data.ttftP50Ms}ms`} />
        </div>
      )}

      {/* Upstreams */}
      <section className="flex flex-col gap-3 sm:gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-main">Upstreams</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-muted tabular">{nodes.data?.length ?? 0} nodes</span>
            {addButton}
          </div>
        </div>

        {nodes.data && nodes.data.length === 0 ? (
          <Card padding="lg" className="flex flex-col items-center justify-center gap-3 text-center">
            <span className="material-symbols-outlined text-[40px] text-text-subtle">dns</span>
            <p className="text-sm text-text-muted">No upstreams yet. Add one to start routing.</p>
            {addButton}
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 sm:gap-4">
            {nodes.data?.map((n) => <NodeCard key={n.id} node={n} />)}
          </div>
        )}
      </section>

      {/* Recent failures */}
      {failures.data && failures.data.length > 0 && (
        <section className="flex flex-col gap-3 sm:gap-4">
          <h2 className="text-sm font-semibold text-text-main">Recent Failures</h2>
          <Card padding="none" className="overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-alt text-left">
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Time</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Request</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Node</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Error</th>
                  <th className="px-4 py-2 text-xs font-medium text-text-muted">Message</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs tabular">
                {failures.data.map((f) => (
                  <tr key={f.id} className="border-t border-border-subtle">
                    <td className="px-4 py-2 text-text-muted">{f.at}</td>
                    <td className="px-4 py-2 text-text-main">{f.requestId}</td>
                    <td className="px-4 py-2 text-text-main">{f.nodeName}</td>
                    <td className="px-4 py-2">
                      <Badge variant={f.errorCode === "rate_limited" ? "warning" : "error"} size="sm">
                        {f.errorCode}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-text-muted">{f.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      <AddUpstreamModal isOpen={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
