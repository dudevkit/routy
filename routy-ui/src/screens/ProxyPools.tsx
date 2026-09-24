import { useState } from "react";
import { useCreatePool, useDeletePool, usePools, useTestPool, useUpdatePool } from "../api/hooks";
import type { PoolTestResult, ProxyPool } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtDateTime } from "../utils/format";
import { PencilSimple, Plus, Trash, WifiHigh, XCircle } from "../components/icons";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Toggle } from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

/** config.urls is the shape the backend probes; the UI edits it as lines of text. */
function poolUrls(pool: ProxyPool | null | undefined): string[] {
  const urls = pool?.config?.urls;
  if (!Array.isArray(urls)) return [];
  return urls.map((u) => (typeof u === "string" ? u : typeof u === "object" && u !== null ? String(u.url ?? "") : ""));
}

function toUrls(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function PoolFormModal({
  isOpen,
  onClose,
  editing,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: ProxyPool | null;
}) {
  const toast = useToast();
  const create = useCreatePool();
  const update = useUpdatePool();
  const [name, setName] = useState(editing?.name ?? "");
  const [urls, setUrls] = useState(poolUrls(editing).join("\n"));

  const busy = create.isPending || update.isPending;
  const canSave = name.trim().length > 0;

  const submit = () => {
    const config = { urls: toUrls(urls) };
    const done = () => {
      toast(editing ? "Pool updated" : "Pool created");
      onClose();
    };
    const fail = (err: unknown) => toastApiError(toast, err, "Save failed");
    if (editing) update.mutate({ id: editing.id, patch: { name: name.trim(), config } }, { onSuccess: done, onError: fail });
    else create.mutate({ name: name.trim(), config }, { onSuccess: done, onError: fail });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : "New Proxy Pool"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Plus size={15} />} disabled={!canSave} loading={busy} onClick={submit}>
            {editing ? "Save Pool" : "Create Pool"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="residential" />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-main">Proxy URLs</span>
          <textarea
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={"http://user:pass@host:8080\nsocks5://host:1080"}
            className="w-full resize-y rounded-[10px] border border-transparent bg-surface-2 p-3 font-mono text-xs text-text-main placeholder:text-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all duration-150"
          />
          <span className="text-xs text-text-muted">One per line · each is probed by Test Pool</span>
        </label>
      </div>
    </Modal>
  );
}

function PoolCard({ pool }: { pool: ProxyPool }) {
  const toast = useToast();
  const testPool = useTestPool();
  const update = useUpdatePool();
  const remove = useDeletePool();
  const [result, setResult] = useState<PoolTestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const urls = poolUrls(pool);

  const runTest = () =>
    testPool.mutate(pool.id, {
      onSuccess: (r) => {
        setResult(r);
        const alive = r.results.filter((x) => x.ok).length;
        toast(r.ok ? `${alive}/${r.results.length} proxies alive` : "No live proxy in this pool", r.ok ? "success" : "error");
      },
      onError: (err) => toastApiError(toast, err, "Test failed"),
    });

  const setEnabled = (enabled: boolean) =>
    update.mutate(
      { id: pool.id, patch: { enabled } },
      {
        onError: (err) => toastApiError(toast, err, "Toggle failed"),
      },
    );

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={pool.enabled ? "green" : "gray"} />
          <h3 className="min-w-0 break-words text-sm font-semibold text-text-main sm:truncate" title={pool.name}>{pool.name}</h3>
          <Badge variant="default" size="sm">
            {pool.kind}
          </Badge>
          <span className="text-[11px] text-text-subtle tabular">{urls.length} urls</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" icon={<WifiHigh size={13} />} loading={testPool.isPending} onClick={runTest}>
            Test
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Edit ${pool.name}`}
            icon={<PencilSimple size={13} />}
            onClick={() => setEditing(true)}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete ${pool.name}`}
            className="hover:bg-danger/10 hover:text-danger"
            icon={<Trash size={13} />}
            onClick={() => setConfirmDelete(true)}
          />
        </div>
      </div>

      <Toggle
        label="Enabled"
        hint={pool.enabled ? "Connections may draw from this pool" : "Excluded from routing"}
        checked={pool.enabled}
        loading={update.isPending}
        onChange={setEnabled}
      />

      {result && (
        <div className="flex flex-col gap-1 border-t border-border-subtle pt-2">
          {result.results.map((r) => (
            <div key={r.url} className="flex items-center gap-2 font-mono text-[11px]">
              {r.ok ? (
                <StatusDot tone="green" className="size-1.5" />
              ) : (
                <XCircle size={12} className="shrink-0 text-danger" />
              )}
              <span className="min-w-0 flex-1 break-all text-text-muted sm:truncate" title={r.url}>{r.url}</span>
              <span className="shrink-0 text-text-main tabular">{r.ok ? `${r.latencyMs}ms` : (r.error ?? "failed")}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-text-subtle">updated {fmtDateTime(pool.updatedAt)}</p>

      <Modal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${pool.name}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                remove.mutate(pool.id, {
                  onSuccess: () => {
                    toast("Pool deleted");
                    setConfirmDelete(false);
                  },
                  onError: (err) => toastApiError(toast, err, "Delete failed"),
                })
              }
            >
              Delete Pool
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">Connections bound to this pool lose their egress route.</p>
      </Modal>

      {editing && <PoolFormModal isOpen={editing} onClose={() => setEditing(false)} editing={pool} />}
    </Card>
  );
}

export function ProxyPools() {
  const pools = usePools();
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          Outbound proxy pools — relay deployment (Vercel/Cloudflare/Deno) is deferred to v2.
        </p>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New Pool
        </Button>
      </div>

      {pools.isLoading ? (
        <Skeleton rows={4} />
      ) : (pools.data?.length ?? 0) === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-16 text-center">
          <WifiHigh size={40} className="text-text-subtle" />
          <p className="text-sm text-text-muted">No proxy pools yet. Add one to route upstream traffic through a proxy.</p>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            New Pool
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 sm:gap-4">
          {pools.data?.map((p) => (
            <PoolCard key={p.id} pool={p} />
          ))}
        </div>
      )}

      <PoolFormModal isOpen={creating} onClose={() => setCreating(false)} editing={null} />
    </div>
  );
}
