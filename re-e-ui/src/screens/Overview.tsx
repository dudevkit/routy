import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
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
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { StatusDot } from "../components/ui/StatusDot";
import { useToast } from "../components/ui/Toast";
import { cn } from "../utils/cn";

const statusBadge: Record<NodeStatus, { variant: "success" | "warning" | "error" | "neutral"; label: string }> = {
  healthy: { variant: "success", label: "healthy" },
  degraded: { variant: "warning", label: "degraded" },
  down: { variant: "error", label: "breaker open" },
  disabled: { variant: "neutral", label: "disabled" },
};

const dotTone: Record<NodeStatus, "green" | "amber" | "red" | "gray"> = {
  healthy: "green",
  degraded: "amber",
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
      className={cn(
        "inline-flex h-6 max-w-[280px] cursor-pointer items-center gap-1.5 rounded-sm bg-gray-alpha-200 px-2 font-mono text-11 text-gray-900 transition-colors duration-150 hover:bg-gray-alpha-300 focus-ring",
      )}
    >
      {copied ? <Check size={11} className="shrink-0 text-green-700" /> : <Copy size={11} className="shrink-0 text-gray-600" />}
      <span className="truncate">{value}</span>
    </button>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-12 text-gray-600">{label}</span>
      <span className="font-mono text-20 tabular">{value}</span>
      {sub && <span className="text-11 text-gray-600">{sub}</span>}
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
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={dotTone[node.status]} />
          <span className="truncate text-14 font-medium">{node.name}</span>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" onClick={onTest} disabled={testNode.isPending}>
            {testNode.isPending ? "Testing…" : "Test"}
          </Button>
          {node.status === "down" && (
            <Button
              size="sm"
              variant="tertiary"
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
            variant="tertiary"
            aria-label={`Remove ${node.name}`}
            className="hover:bg-red-100 hover:text-red-700"
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      <div className="truncate font-mono text-12 text-gray-600">{node.baseUrl}</div>

      <div className="flex items-center gap-4 text-12 text-gray-600">
        <span className="font-mono tabular">
          {node.latencyMs == null ? "—" : `${node.latencyMs}ms`}
        </span>
        <span className="tabular">{node.modelCount} models</span>
        <span className="font-mono">{node.prefix ? `prefix ${node.prefix}` : "no prefix"}</span>
        <span className="ml-auto font-mono">{node.keyMasked}</span>
      </div>

      {node.lastError && <p className="font-mono text-12 text-red-700">{node.lastError}</p>}

      <Modal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${node.name}?`}
        width={380}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="error"
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
        <p className="text-13 text-gray-700">
          Requests routing to this node will fail until a replacement is added.
        </p>
      </Modal>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-12 text-gray-700">{label}</span>
      {children}
      {hint && <span className="text-11 text-gray-600">{hint}</span>}
    </label>
  );
}

type TestState = null | "testing" | TestResult;

const emptyForm = { name: "", baseUrl: "", apiKey: "", prefix: "" };

function AddUpstreamModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      open={open}
      onClose={close}
      title="Add Upstream"
      footer={
        <>
          <Button variant="tertiary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSave || addNode.isPending}
            onClick={() =>
              addNode.mutate(form, {
                onSuccess: () => {
                  toast("Upstream added");
                  close();
                },
              })
            }
          >
            {addNode.isPending ? "Adding…" : "Add Upstream"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="My upstream"
          />
        </Field>
        <Field label="Base URL">
          <Input
            mono
            value={form.baseUrl}
            onChange={(e) => {
              setForm({ ...form, baseUrl: e.target.value });
              setTest(null);
            }}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field label="API Key">
          <Input
            mono
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder="sk-…"
          />
        </Field>
        <Field label="Model Prefix" hint="Optional · models with this prefix route to the node">
          <Input
            mono
            value={form.prefix}
            onChange={(e) => setForm({ ...form, prefix: e.target.value })}
            placeholder="or/"
          />
        </Field>

        <div className="flex min-h-7 items-center gap-3 pt-1">
          <Button
            variant="secondary"
            size="sm"
            disabled={!urlLooksValid || test === "testing"}
            onClick={runTest}
          >
            {test === "testing" ? "Testing…" : "Test Connection"}
          </Button>
          {test && test !== "testing" &&
            (test.ok ? (
              <span className="flex items-center gap-1.5 font-mono text-12 text-green-700 tabular">
                <Check size={13} />
                200 · {test.latencyMs}ms · {test.modelCount} models
              </span>
            ) : (
              <span className="text-12 text-red-700">{test.error}</span>
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
    <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAddOpen(true)}>
      Add Upstream
    </Button>
  );

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-24 font-semibold">Overview</h1>
        {addButton}
      </header>

      {gateway.data && (
        <Card className="flex items-center gap-3 p-3 text-12">
          <StatusDot tone={gateway.data.online ? "green" : "red"} pulse={gateway.data.online} />
          <span className="text-gray-700">Proxy endpoint</span>
          <CopyChip value={gateway.data.endpoint} />
          <span className="text-gray-700">API key</span>
          <CopyChip value={gateway.data.keyMasked} />
          <span className="ml-auto font-mono text-11 text-gray-600">v{gateway.data.version}</span>
        </Card>
      )}

      {stats.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard label="Requests · today" value={stats.data.requestsToday.toLocaleString()} />
          <StatCard label="Tokens · 7d" value={fmtTokens(stats.data.tokens7d)} />
          <StatCard label="Cost · 7d" value={`$${stats.data.costUsd7d.toFixed(2)}`} />
          <StatCard label="Error rate" value={`${stats.data.errorRatePct.toFixed(1)}%`} />
          <StatCard label="TTFT · p50" value={`${stats.data.ttftP50Ms}ms`} />
        </div>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-14 font-semibold">Upstreams</h2>
          <span className="text-12 text-gray-600 tabular">{nodes.data?.length ?? 0} nodes</span>
        </div>

        {nodes.data && nodes.data.length === 0 ? (
          <EmptyState
            message="No upstreams yet. Add one to start routing."
            action={addButton}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {nodes.data?.map((n) => <NodeCard key={n.id} node={n} />)}
          </div>
        )}
      </section>

      {failures.data && failures.data.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-14 font-semibold">Recent Failures</h2>
          <Card className="overflow-hidden p-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-alpha-300 bg-background-300 text-left">
                  <th className="px-4 py-2 text-12 font-medium text-gray-600">Time</th>
                  <th className="px-4 py-2 text-12 font-medium text-gray-600">Request</th>
                  <th className="px-4 py-2 text-12 font-medium text-gray-600">Node</th>
                  <th className="px-4 py-2 text-12 font-medium text-gray-600">Error</th>
                  <th className="px-4 py-2 text-12 font-medium text-gray-600">Message</th>
                </tr>
              </thead>
              <tbody className="font-mono text-12 tabular">
                {failures.data.map((f) => (
                  <tr key={f.id} className="border-b border-gray-alpha-200 last:border-0">
                    <td className="px-4 py-2 text-gray-600">{f.at}</td>
                    <td className="px-4 py-2 text-gray-800">{f.requestId}</td>
                    <td className="px-4 py-2 text-gray-800">{f.nodeName}</td>
                    <td className="px-4 py-2">
                      <Badge variant={f.errorCode === "rate_limited" ? "warning" : "error"}>
                        {f.errorCode}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-gray-700">{f.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      <AddUpstreamModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
