import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useAddConnection,
  useAddModel,
  useBatchAddConnections,
  useBulkModels,
  useConnections,
  useDeleteConnection,
  useImportModels,
  useNodeModels,
  useNodes,
  useRemoveModel,
  useRemoveNode,
  useResetBreaker,
  useTestAllKeys,
  useTestKey,
  useTestModel,
  useUpdateConnection,
  useUpdateModel,
  useUpdateNode,
} from "../api/hooks";
import type { KeyTestResult, ModelBulkAction, ModelBulkResult, NodeConnection, NodeModel, UpstreamNode } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtMs } from "../utils/format";
import { cn } from "../utils/cn";
import {
  ArrowLeft, ArrowsClockwise, Check, CheckCircle, CheckSquare, DownloadSimple, PencilSimple,
  Plus, Prohibit, Trash, WifiHigh, XCircle,
} from "../components/icons";
import { NodeFormModal } from "../components/NodeFormModal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { CopyButton } from "../components/ui/CopyButton";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { Select } from "../components/ui/Select";
import { Tabs } from "../components/ui/Tabs";
import { Toggle } from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

const NODE_STATUS: Record<string, { badge: "success" | "warning" | "error" | "default"; label: string }> = {
  healthy: { badge: "success", label: "healthy" },
  degraded: { badge: "warning", label: "degraded" },
  down: { badge: "error", label: "breaker open" },
  disabled: { badge: "default", label: "disabled" },
};

/** "2h ago" — how old a stored probe result is. */
function fmtAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
/**
 * Live rotation status of one key, next to the DB status: a rate-limited key shows its
 * cooldown counting down, a twice-failed key shows it is out until re-enabled. Ticks
 * only while some key is actually cooling — a per-second interval for every row would
 * be waste.
 */
function KeyStatusBadge({ conn }: { conn: NodeConnection }) {
  const cooling = conn.health?.state === "cooldown" && conn.health.openUntil;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!cooling) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [cooling]);

  if (cooling) {
    const msLeft = Math.max(0, Date.parse(conn.health!.openUntil!) - Date.now());
    const m = Math.floor(msLeft / 60_000);
    const s = Math.floor((msLeft % 60_000) / 1000);
    return (
      <span title={conn.health?.lastError ?? "rate-limited by the provider"}>
        <Badge variant="warning" size="sm">cooldown {m > 0 ? `${m}m ` : ""}{s}s</Badge>
      </span>
    );
  }
  if (conn.health?.state === "disabled") {
    return (
      <span title={conn.health.lastError ?? "disabled after repeated failures"}>
        <Badge variant="error" size="sm">disabled · {conn.health.strikes ?? 2} strikes</Badge>
      </span>
    );
  }
  return <Badge variant={conn.status === "active" ? "success" : "default"} size="sm">{conn.status ?? "active"}</Badge>;
}

/** Probe outcome cell — "never" is distinct from "failed". */
function TestCell({ at, ok, ms, error }: { at?: string | null; ok?: boolean | null; ms?: number | null; error?: string | null }) {
  if (!at) return <span className="text-xs text-text-subtle">never</span>;
  // A stored verdict is a snapshot, not a live state — always say how old it is,
  // so a result from before a fix can never read as a current failure.
  const when = fmtAgo(at);
  const title = `${error ? `${error}\n` : ""}tested ${when} (${new Date(at).toLocaleString()})`;
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-success tabular" title={title}>
        <CheckCircle size={13} weight="fill" className="shrink-0" />
        ok · {fmtMs(ms ?? null)}
        <span className="text-text-subtle">{when}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-danger" title={title}>
      <XCircle size={13} weight="fill" className="shrink-0" />
      <span className="truncate max-w-[22ch]">{error || "failed"}</span>
      <span className="text-text-subtle shrink-0">{when}</span>
    </span>
  );
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-text-muted">
        {children}
      </td>
    </tr>
  );
}

const TH = "px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-text-subtle";
const TD = "px-4 py-2.5 text-sm text-text-main align-middle";

/* ── Models ────────────────────────────────────────────────────────────────── */
function ModelsTab({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const models = useNodeModels(node.id);
  const connections = useConnections(node.id);
  const addModel = useAddModel();
  const updateModel = useUpdateModel();
  const removeModel = useRemoveModel();
  const importModels = useImportModels();
  const testModel = useTestModel();
  const bulkModels = useBulkModels();
  const [draft, setDraft] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkResults, setBulkResults] = useState<ModelBulkResult["results"] | null>(null);

  const rows = models.data?.models ?? [];
  const hasKey = (connections.data?.length ?? 0) > 0;
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const selectedRows = rows.filter((r) => selected.has(r.id));

  /** The routable id a client actually pastes — prefix included. */
  const routableId = (m: string) => `${node.prefix}/${m}`;

  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));

  const runBulk = (action: ModelBulkAction) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    bulkModels.mutate(
      { nodeId: node.id, ids, action },
      {
        onSuccess: (r) => {
          if (action === "test") {
            setBulkResults(r.results ?? []);
            toast(`${r.ok}/${r.tested} models served`, r.ok === r.tested ? "success" : "error");
            return;
          }
          toast(`${r.changed} model${r.changed === 1 ? "" : "s"} ${action === "delete" ? "removed" : action === "show" ? "listed" : "hidden"}`);
          exitSelect();
        },
        onError: (err) => toastApiError(toast, err, `Bulk ${action} failed`),
      },
    );
  };

  const submit = () => {
    const model = draft.trim();
    if (!model) return;
    addModel.mutate(
      { nodeId: node.id, model },
      {
        onSuccess: () => { toast(`Added ${model}`); setDraft(""); },
        onError: (err) => toastApiError(toast, err, "Failed to add model"),
      },
    );
  };

  const runImport = () =>
    importModels.mutate(
      { nodeId: node.id },
      {
        onSuccess: (r) => {
          const bits = [`${r.imported} model${r.imported === 1 ? "" : "s"} imported`];
          if (r.kept) bits.push(`${r.kept} manual kept`);
          if (r.stale) bits.push(`${r.stale} now stale`);
          toast(bits.join(" · "));
        },
        onError: (err) => toastApiError(toast, err, "Import failed"),
      },
    );

  const runTest = (row: NodeModel) => {
    setTestingId(row.id);
    testModel.mutate(
      { nodeId: node.id, modelId: row.id },
      {
        onSuccess: (r) => {
          toast(r.result.ok ? `${row.model} served in ${fmtMs(r.result.ttftMs)}` : `${row.model}: ${r.result.error}`, r.result.ok ? "success" : "error");
        },
        onError: (err) => toastApiError(toast, err, "Test failed"),
        onSettled: () => setTestingId(null),
      },
    );
  };

  return (
    <>
      <Card padding="none">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-3">
          <Button
            variant="outline"
            size="sm"
            icon={<DownloadSimple size={14} />}
            loading={importModels.isPending}
            disabled={!hasKey}
            onClick={runImport}
            title={hasKey ? "Fetch the model list from this provider" : "Add an API key first"}
          >
            Import from provider
          </Button>
          <span className="text-xs text-text-subtle sm:text-[11px]">optional — add ids by hand instead</span>

          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="model-id"
              className="w-52 min-w-0 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main placeholder:text-text-main/40 focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={!draft.trim()} loading={addModel.isPending} onClick={submit}>
              Add model
            </Button>
            <Button
              variant={selecting ? "secondary" : "outline"}
              size="sm"
              icon={<CheckSquare size={14} />}
              disabled={rows.length === 0}
              onClick={() => (selecting ? exitSelect() : setSelecting(true))}
            >
              {selecting ? "Done" : "Select"}
            </Button>
          </div>
        </div>

        {selecting && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-2/50 px-3 py-2">
            <span className="text-xs text-text-muted">
              <span className="font-mono text-text-main">{selected.size}</span> of {rows.length} selected
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" onClick={toggleAll}>
                {allSelected ? "Clear all" : "Select all"}
              </Button>
              <Button variant="outline" size="sm" icon={<WifiHigh size={13} />} disabled={selected.size === 0 || !hasKey} loading={bulkModels.isPending && bulkModels.variables?.action === "test"} onClick={() => runBulk("test")}>
                Test
              </Button>
              <Button variant="outline" size="sm" icon={<Prohibit size={13} />} disabled={selected.size === 0} loading={bulkModels.isPending && bulkModels.variables?.action === "hide"} onClick={() => runBulk("hide")}>
                Hide
              </Button>
              <Button variant="outline" size="sm" icon={<Check size={13} />} disabled={selected.size === 0} loading={bulkModels.isPending && bulkModels.variables?.action === "show"} onClick={() => runBulk("show")}>
                Show
              </Button>
              <Button variant="danger" size="sm" icon={<Trash size={13} />} disabled={selected.size === 0} onClick={() => setConfirmBulkDelete(true)}>
                Delete
              </Button>
            </div>
          </div>
        )}

        <div className="w-full overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-subtle">
              {selecting && (
                <th className="w-9 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all models"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
                  />
                </th>
              )}
              <th className={TH}>Model</th>
              <th className={cn(TH, "hidden md:table-cell")}>Source</th>
              <th className={TH}>State</th>
              <th className={cn(TH, "hidden md:table-cell")}>Last test</th>
              <th className={`${TH} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {models.isLoading ? (
              <EmptyRow colSpan={selecting ? 6 : 5}><Skeleton rows={2} /></EmptyRow>
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={selecting ? 6 : 5}>
                No models yet. Import the list from this provider, or add an id by hand and test it —
                the list is for discovery, it never blocks a request.
              </EmptyRow>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    "border-b border-border-subtle last:border-0 hover:bg-surface-2/40",
                    selected.has(row.id) && "bg-accent/5",
                  )}
                >
                  {selecting && (
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.model}`}
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
                      />
                    </td>
                  )}
                  <td className={`${TD} font-mono text-xs`}>
                    <div className="flex items-center gap-1">
                      <span className="truncate" title={row.model}>{row.model}</span>
                      <CopyButton value={routableId(row.model)} title={`Copy ${routableId(row.model)}`} />
                    </div>
                  </td>
                  <td className={cn(TD, "hidden md:table-cell")}>
                    <Badge variant={row.source === "manual" ? "default" : "info"} size="sm">{row.source}</Badge>
                  </td>
                  <td className={TD}>
                    <div className="flex items-center gap-1.5">
                      {row.stale && <Badge variant="warning" size="sm">stale</Badge>}
                      {!row.enabled && <Badge variant="default" size="sm">off</Badge>}
                      {row.enabled && !row.stale && <span className="text-xs text-text-subtle">listed</span>}
                    </div>
                  </td>
                  <td className={cn(TD, "hidden md:table-cell")}>
                    <TestCell at={row.lastTestAt} ok={row.lastTestOk} ms={row.lastTestTtftMs} error={row.lastTestError} />
                  </td>
                  <td className={`${TD} text-right`}>
                    <div className="inline-flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        icon={<WifiHigh size={13} />}
                        loading={testingId === row.id}
                        disabled={!hasKey}
                        onClick={() => runTest(row)}
                        title={hasKey ? "Send a real one-token stream" : "Add an API key first"}
                      >
                        Test
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={row.enabled ? <Prohibit size={13} /> : <Check size={13} />}
                        onClick={() => updateModel.mutate({ nodeId: node.id, modelId: row.id, patch: { enabled: !row.enabled } }, { onError: (e) => toastApiError(toast, e, "Failed to update") })}
                        title={row.enabled ? "Hide from discovery" : "List it again"}
                      />
                      <Button variant="ghost" size="sm" icon={<Trash size={13} />} onClick={() => setConfirmId(row.id)} title="Remove" />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </Card>

      {bulkResults && (
        <Card padding="sm" className="mt-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-main">
              Last bulk test · <span className="font-mono">{bulkResults.filter((r) => r.ok).length}/{bulkResults.length} served</span>
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setBulkResults(null)}>Dismiss</Button>
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {bulkResults.map((r) => (
              <div key={r.modelId} className="flex items-center gap-3 text-xs">
                <span className="w-64 min-w-0 truncate font-mono text-text-main" title={r.model}>{r.model}</span>
                <TestCell at="now" ok={r.ok} ms={r.ttftMs} error={r.error} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal
        isOpen={!!confirmId}
        onClose={() => setConfirmId(null)}
        title="Remove model"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmId(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmId) removeModel.mutate({ nodeId: node.id, modelId: confirmId }, { onSuccess: () => toast("Model removed"), onError: (e) => toastApiError(toast, e, "Failed to remove") });
                setConfirmId(null);
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          This only removes it from the discovery list. Requests for it still route through this provider.
        </p>
      </Modal>

      <Modal
        isOpen={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        title={`Remove ${selected.size} model${selected.size === 1 ? "" : "s"}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmBulkDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmBulkDelete(false);
                runBulk("delete");
              }}
            >
              Remove {selected.size}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          They leave the discovery list only. Requests for them still route through this provider.
        </p>
        <div className="mt-3 max-h-40 overflow-y-auto rounded-md border border-border-subtle bg-surface-2 p-2">
          {selectedRows.map((r) => (
            <div key={r.id} className="break-all font-mono text-xs text-text-muted sm:truncate sm:text-[11px]" title={r.model}>{r.model}</div>
          ))}
        </div>
      </Modal>
    </>
  );
}

/* ── API keys ──────────────────────────────────────────────────────────────── */
function KeysTab({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const connections = useConnections(node.id);
  const addConnection = useAddConnection();
  const batchAdd = useBatchAddConnections();
  const deleteConnection = useDeleteConnection();
  const updateConnection = useUpdateConnection();
  const testKey = useTestKey();
  const testAll = useTestAllKeys();
  const [single, setSingle] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState("");
  const [bulkLabel, setBulkLabel] = useState("");
  const [testAfter, setTestAfter] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [allResults, setAllResults] = useState<KeyTestResult[] | null>(null);

  const conns = connections.data ?? [];
  const parsedBulk = useMemo(
    () =>
      bulk
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf(",");
          return idx > 0 ? { name: line.slice(0, idx).trim(), apiKey: line.slice(idx + 1).trim() } : { name: "", apiKey: line };
        })
        .filter((k) => k.apiKey.length > 0),
    [bulk],
  );

  const addSingle = () => {
    const apiKey = single.trim();
    if (!apiKey) return;
    addConnection.mutate(
      { nodeId: node.id, apiKey },
      {
        onSuccess: () => { toast("Key added"); setSingle(""); },
        onError: (err) => toastApiError(toast, err, "Failed to add key"),
      },
    );
  };

  const addBulk = () => {
    if (parsedBulk.length === 0) return;
    batchAdd.mutate(
      { nodeId: node.id, entries: parsedBulk.map((k) => ({ name: k.name || undefined, apiKey: k.apiKey })), name: bulkLabel.trim() || undefined },
      {
        onSuccess: (r) => {
          toast(`${r.created} keys added`);
          setBulk("");
          setBulkOpen(false);
          if (testAfter) runAll();
        },
        onError: (err) => toastApiError(toast, err, "Bulk add failed"),
      },
    );
  };

  const runAll = () =>
    testAll.mutate(
      { nodeId: node.id },
      {
        onSuccess: (r) => {
          setAllResults(r.results);
          toast(`${r.ok}/${r.tested} keys ok`, r.ok === r.tested ? "success" : "error");
        },
        onError: (err) => toastApiError(toast, err, "Key test failed"),
      },
    );

  const runOne = (c: NodeConnection) => {
    setTestingId(c.id);
    testKey.mutate(
      { connectionId: c.id },
      {
        onSuccess: (r) => toast(r.ok ? `${c.name} ok · ${fmtMs(r.latencyMs)}` : `${c.name}: ${r.error}`, r.ok ? "success" : "error"),
        onError: (err) => toastApiError(toast, err, "Test failed"),
        onSettled: () => setTestingId(null),
      },
    );
  };

  return (
    <>
      <Card padding="none">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-3">
          <input
            value={single}
            onChange={(e) => setSingle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addSingle(); }}
            placeholder="sk-…"
            className="w-64 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main placeholder:text-text-main/40 focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={!single.trim()} loading={addConnection.isPending} onClick={addSingle}>
            Add key
          </Button>
          <Button variant="outline" size="sm" icon={<Plus size={14} />} onClick={() => setBulkOpen(true)}>
            Add bulk
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            icon={<WifiHigh size={14} />}
            loading={testAll.isPending}
            disabled={conns.length === 0}
            onClick={runAll}
          >
            Test all keys
          </Button>
        </div>

        <div className="w-full overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-subtle">
              <th className={TH}>Label</th>
              <th className={cn(TH, "hidden md:table-cell")}>Key</th>
              <th className={TH}>Status</th>
              <th className={cn(TH, "hidden md:table-cell")}>Last test</th>
              <th className={`${TH} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {connections.isLoading ? (
              <EmptyRow colSpan={5}><Skeleton rows={2} /></EmptyRow>
            ) : conns.length === 0 ? (
              <EmptyRow colSpan={5}>
                No API keys yet. Add one, or paste a list with “Add bulk” (one per line, <span className="font-mono">label,key</span>).
              </EmptyRow>
            ) : (
              conns.map((c) => (
                <tr key={c.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-2/40">
                  <td className={TD}>
                    <span className="block max-w-[22ch] truncate sm:max-w-none" title={c.name || "key"}>{c.name || "key"}</span>
                  </td>
                  <td className={cn(TD, "hidden md:table-cell font-mono text-xs text-text-muted")}>{c.keyMasked}</td>
                  <td className={TD}>
                    <KeyStatusBadge conn={c} />
                  </td>
                  <td className={cn(TD, "hidden md:table-cell")}>
                    <TestCell at={c.lastTestAt} ok={c.lastTestOk} ms={c.lastTestTtftMs} error={c.lastError} />
                  </td>
                  <td className={`${TD} text-right`}>
                    <div className="inline-flex items-center gap-1">
                      <Button variant="outline" size="sm" icon={<WifiHigh size={13} />} loading={testingId === c.id} onClick={() => runOne(c)}>
                        Test
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={c.status === "active" ? <Prohibit size={13} /> : <Check size={13} />}
                        onClick={() => updateConnection.mutate({ id: c.id, patch: { status: c.status === "active" ? "disabled" : "active" } }, { onError: (e) => toastApiError(toast, e, "Failed to update") })}
                        title={c.status === "active" ? "Disable" : "Enable"}
                      />
                      <Button variant="ghost" size="sm" icon={<Trash size={13} />} onClick={() => setConfirmId(c.id)} title="Remove" />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </Card>

      {allResults && (
        <Card padding="sm" className="mt-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-main">Last bulk test</h3>
            <Button variant="ghost" size="sm" onClick={() => setAllResults(null)}>Dismiss</Button>
          </div>
          <div className="flex flex-col gap-1">
            {allResults.map((r) => (
              <div key={r.connectionId} className="flex items-center gap-3 text-xs">
                <span className="w-40 min-w-0 truncate text-text-main" title={r.name || r.connectionId}>{r.name || r.connectionId}</span>
                <TestCell at={r.ok ? "now" : "now"} ok={r.ok} ms={r.latencyMs} error={r.error} />
                <span className="text-text-subtle">{r.modelCount} models</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Add keys in bulk"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBulkOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={parsedBulk.length === 0} loading={batchAdd.isPending} onClick={addBulk}>
              Add {parsedBulk.length || ""} key{parsedBulk.length === 1 ? "" : "s"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input label="Label prefix (optional)" value={bulkLabel} onChange={(e) => setBulkLabel(e.target.value)} placeholder="team" />
          <div>
            <label className="mb-1 block text-xs font-medium text-text-main">
              One key per line — <span className="font-mono">label,key</span> or just the key
            </label>
            <textarea
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              placeholder={"prod,sk-abc123\nteam-2,sk-def456\nsk-ghi789"}
              className="min-h-[140px] w-full resize-y rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-xs text-text-main placeholder:text-text-main/40 focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <p className="mt-1 text-xs text-text-main/50">
              {parsedBulk.length} key{parsedBulk.length === 1 ? "" : "s"} detected
              {parsedBulk.some((k) => k.name) ? ` · ${parsedBulk.filter((k) => k.name).length} with a label` : ""}
            </p>
          </div>
          <Toggle
            label="Test each key after adding"
            hint="Probes every new key against the provider. Diagnostics only — it never counts as traffic."
            checked={testAfter}
            onChange={setTestAfter}
          />
        </div>
      </Modal>

      <Modal
        isOpen={!!confirmId}
        onClose={() => setConfirmId(null)}
        title="Remove API key"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmId(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmId) deleteConnection.mutate(confirmId, { onSuccess: () => toast("Key removed"), onError: (e) => toastApiError(toast, e, "Failed to remove") });
                setConfirmId(null);
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">Requests will no longer use this key. Its usage history is kept.</p>
      </Modal>
    </>
  );
}

/* ── Settings ──────────────────────────────────────────────────────────────── */
function SettingsTab({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const navigate = useNavigate();
  const resetBreaker = useResetBreaker();
  const updateNode = useUpdateNode();
  const removeNode = useRemoveNode();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const pricing = node.data?.pricing as { inputPer1M?: number; outputPer1M?: number } | undefined;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-start gap-4 py-2">
      <span className="w-40 shrink-0 text-xs text-text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-text-main">{value}</span>
    </div>
  );

  return (
    <>
      <Card padding="sm" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-main">Provider</h3>
          <Button variant="outline" size="sm" icon={<PencilSimple size={13} />} onClick={() => setEditOpen(true)}>
            Edit
          </Button>
        </div>
        <div className="divide-y divide-border-subtle">
          {row("Name", node.name)}
          {row("Model prefix", <span className="font-mono text-xs">{node.prefix}</span>)}
          {row("Base URL", <span className="font-mono text-xs break-all">{node.baseUrl}</span>)}
          {row("Pricing", pricing ? <span className="font-mono text-xs">${pricing.inputPer1M ?? 0}/1M in · ${pricing.outputPer1M ?? 0}/1M out</span> : <span className="text-text-muted">unmetered — no cost recorded, never blocked by the budget</span>)}
          {row("Stall watchdog", node.data?.streamIdleTimeoutMs !== undefined ? <span className="font-mono text-xs">{String(node.data.streamIdleTimeoutMs)}ms</span> : <span className="text-text-muted">gateway default</span>)}
          {row(
            "Key strategy",
            <div className="flex flex-col gap-1">
              <Select
                className="max-w-xs"
                value={node.data?.keyStrategy === "fallback" ? "fallback" : "round-robin"}
                options={[
                  { value: "round-robin", label: "Round-robin — spread requests across keys" },
                  { value: "fallback", label: "Fallback — use the first key until it fails" },
                ]}
                disabled={updateNode.isPending}
                onChange={(e) =>
                  updateNode.mutate(
                    { id: node.id, patch: { data: { ...node.data, keyStrategy: e.target.value } } },
                    {
                      onSuccess: () => toast(e.target.value === "fallback" ? "Keys: first key first" : "Keys: spread across all"),
                      onError: (err) => toastApiError(toast, err, "Failed to save key strategy"),
                    },
                  )
                }
              />
              <span className="text-[11px] text-text-muted">
                Either way a failing key is skipped within the same request, and a rate-limited one sits out its cooldown.
              </span>
            </div>,
          )}
        </div>
      </Card>

      <Card padding="sm" className="mt-3 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-text-main">Actions</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={<ArrowsClockwise size={13} />}
            loading={resetBreaker.isPending}
            onClick={() =>
              resetBreaker.mutate(node.id, {
                onSuccess: () => toast("Breaker reset — the provider is a candidate again"),
                onError: (e) => toastApiError(toast, e, "Failed to reset"),
              })
            }
          >
            Reset breaker
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={node.status === "disabled" ? <Check size={13} /> : <Prohibit size={13} />}
            onClick={() =>
              updateNode.mutate({ id: node.id, patch: { enabled: node.status === "disabled" } }, { onSuccess: () => toast(node.status === "disabled" ? "Provider enabled" : "Provider disabled") })
            }
          >
            {node.status === "disabled" ? "Enable" : "Disable"}
          </Button>
          <Button variant="danger" size="sm" icon={<Trash size={13} />} onClick={() => setConfirmDelete(true)}>
            Delete provider
          </Button>
        </div>
      </Card>

      <NodeFormModal isOpen={editOpen} onClose={() => setEditOpen(false)} node={node} />

      <Modal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${node.name}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() =>
                removeNode.mutate(node.id, {
                  onSuccess: () => { toast("Provider deleted"); navigate("/upstreams"); },
                  onError: (e) => toastApiError(toast, e, "Failed to delete"),
                })
              }
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Removes the provider, its API keys and its model list. Requests routed to
          <span className="font-mono"> {node.prefix}/…</span> will stop resolving.
        </p>
      </Modal>
    </>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */
export function ProviderDetail() {
  const { id } = useParams<{ id: string }>();
  const nodes = useNodes();
  const [tab, setTab] = useState("models");
  const node = nodes.data?.find((n) => n.id === id);

  if (nodes.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton rows={2} />
        <Skeleton rows={4} />
      </div>
    );
  }

  if (!node) {
    return (
      <Card padding="sm" className="flex flex-col items-start gap-3">
        <p className="text-sm text-text-muted">That provider no longer exists.</p>
        <Link to="/upstreams" className="text-sm font-semibold text-primary hover:underline">
          Back to providers
        </Link>
      </Card>
    );
  }

  const status = NODE_STATUS[node.status] ?? NODE_STATUS.healthy;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Link to="/upstreams" className="inline-flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-main">
          <ArrowLeft size={13} />
          Providers
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-text-main">{node.name}</h2>
          <Badge variant={status.badge} dot size="sm">{status.label}</Badge>
          <span className="font-mono text-xs text-text-muted">{node.prefix}/</span>
          <span className="font-mono text-xs text-text-subtle">{node.latencyMs !== null ? fmtMs(node.latencyMs) : "no TTFT yet"}</span>
          {node.lastError && <span className="min-w-0 max-w-[40ch] truncate text-xs text-danger" title={node.lastError}>{node.lastError}</span>}
        </div>
        <span className="font-mono text-xs break-all text-text-subtle sm:text-[11px]">{node.baseUrl}</span>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "models", label: `Models${node.modelCount ? ` (${node.modelCount})` : ""}` },
          { value: "keys", label: "API Keys" },
          { value: "settings", label: "Settings" },
        ]}
      />

      {tab === "models" && <ModelsTab node={node} />}
      {tab === "keys" && <KeysTab node={node} />}
      {tab === "settings" && <SettingsTab node={node} />}
    </div>
  );
}
