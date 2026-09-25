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

/** One proxy per pool. Pools written before migration 4 held a list; take its first. */
function poolUrl(pool: ProxyPool | null | undefined): string {
  const url = pool?.config?.url;
  if (typeof url === "string") return url;
  const legacy = pool?.config?.urls;
  if (Array.isArray(legacy)) {
    const first = legacy.map((u) => (typeof u === "string" ? u : u?.url)).find((u) => typeof u === "string" && u.trim());
    if (first) return first;
  }
  return "";
}

/**
 * A proxy URL as displayed: credentials replaced. The list shows which proxy this is,
 * not the password — the same reasoning as masking API keys in the key table.
 */
function maskProxy(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return url;
  }
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
  const [url, setUrl] = useState(poolUrl(editing));
  const [strict, setStrict] = useState(editing?.config?.strict !== false);

  const busy = create.isPending || update.isPending;
  const canSave = name.trim().length > 0 && url.trim().length > 0;

  const submit = () => {
    const config = { url: url.trim(), strict };
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
        <Input
          label="Proxy URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://user:pass@host:8080"
          inputClassName="font-mono"
          hint="One proxy per pool. Credentials in the URL are supported and never logged."
        />
        <Toggle
          label="Strict — fail instead of falling back to a direct request"
          hint={
            strict
              ? "A request that cannot go through this proxy fails. Recommended: a silent direct request leaks your real address."
              : "If the proxy fails, the request is retried without it. Your real address becomes visible to the provider."
          }
          checked={strict}
          onChange={setStrict}
        />
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
  const url = poolUrl(pool);
  // Health shown is the stored verdict, so it survives a reload; a fresh check replaces it.
  const testedAt = result ? new Date().toISOString() : pool.lastTestedAt;
  const testOk = result ? result.ok : pool.testStatus === "active" ? true : pool.testStatus === "error" ? false : null;

  const runTest = () =>
    testPool.mutate(pool.id, {
      onSuccess: (r) => {
        setResult(r);
        // The verdict is stored on the pool by the API; say what actually happened,
        // including the failure reason, instead of a bare "test failed".
        toast(r.ok ? `Proxy reachable · ${r.elapsedMs ?? "?"}ms` : `Proxy failed: ${r.error ?? "unknown"}`, r.ok ? "success" : "error");
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
          <Badge variant={testOk === true ? "success" : testOk === false ? "error" : "default"} size="sm">
            {testOk === true ? "reachable" : testOk === false ? "failing" : "untested"}
          </Badge>
          {pool.config?.strict === false && (
            <span title="A failed proxy falls back to a direct request — the provider sees your real address">
              <Badge variant="warning" size="sm">not strict</Badge>
            </span>
          )}
          {!!pool.boundCount && <span className="text-[11px] text-text-subtle tabular">bound to {pool.boundCount}</span>}
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

      <div className="flex items-center gap-2 font-mono text-[11px] text-text-muted">
        {url ? <span className="min-w-0 break-all sm:truncate" title="credentials are hidden">{maskProxy(url)}</span> : <span className="text-danger">no url set</span>}
      </div>

      <Toggle
        label="Enabled"
        hint={pool.enabled ? "Providers and keys may draw from this pool" : "Excluded from routing"}
        checked={pool.enabled}
        loading={update.isPending}
        onChange={setEnabled}
      />

      {(result || pool.lastError) && (
        <div className="flex items-center gap-2 border-t border-border-subtle pt-2 font-mono text-[11px]">
          {testOk ? <StatusDot tone="green" className="size-1.5" /> : <XCircle size={12} className="shrink-0 text-danger" />}
          <span className="min-w-0 flex-1 break-words text-text-muted">
            {result?.ok ? `reached ${result.testUrl ?? "the test host"} in ${result.elapsedMs ?? "?"}ms` : (result?.error ?? pool.lastError ?? "failed")}
          </span>
        </div>
      )}

      <p className="text-[11px] text-text-subtle">
        {testedAt ? `checked ${fmtDateTime(testedAt)} · ` : "never checked · "}updated {fmtDateTime(pool.updatedAt)}
      </p>

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
