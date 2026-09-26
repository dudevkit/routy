import { useState } from "react";
import {
  useAddPoolEntries, useCreatePool, useDeletePool, useDeletePoolEntry, useMergePools,
  usePools, useResetPoolHealth, useTestPool, useTestPoolEntry, useUpdatePool, useUpdatePoolEntry,
} from "../api/hooks";
import type { ExitHealth, PoolTestResult, ProxyPool, ProxyPoolEntry } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtDateTime } from "../utils/format";
import { Plus, Trash, WifiHigh, XCircle } from "../components/icons";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Toggle } from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

/**
 * An exit as displayed: credentials replaced. The list says which proxy this is, not the
 * password — same reasoning as masking API keys in the key table.
 */
function maskProxy(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return url;
  }
}

/** The most severe live health an exit has, across providers. */
function worstHealth(entry: ProxyPoolEntry): ExitHealth | null {
  const now = Date.now();
  const cooling = (entry.health ?? []).filter((h) => h.state === "cooldown" && h.openUntil && Date.parse(h.openUntil) > now);
  return cooling.sort((a, b) => Date.parse(b.openUntil || "0") - Date.parse(a.openUntil || "0"))[0] ?? null;
}

/**
 * The multi-line paste box, following the bulk-key textarea already in this dashboard: the
 * fleet is entered by pasting a provider's list, which is a different job from typing one
 * value, and a single-line Input cannot do it.
 */
function PasteUrls({
  value,
  onChange,
  label,
  hint,
  rows = 7,
}: {
  value: string;
  onChange: (text: string) => void;
  label: string;
  hint: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-text-main">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={"http://user:pass@host:8080\nsocks5://user:pass@host:1080"}
        className="min-h-[120px] w-full resize-y rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-[11px] text-text-main placeholder:text-text-main/40 focus:outline-none focus:ring-2 focus:ring-accent/40"
      />
      <p className="mt-1 text-xs text-text-main/50">{hint}</p>
    </div>
  );
}

function ExitRow({ entry }: { entry: ProxyPoolEntry }) {
  const toast = useToast();
  const test = useTestPoolEntry();
  const update = useUpdatePoolEntry();
  const remove = useDeletePoolEntry();
  const cooling = worstHealth(entry);
  const minutesLeft = cooling?.openUntil ? Math.max(1, Math.round((Date.parse(cooling.openUntil) - Date.now()) / 60_000)) : 0;

  const runTest = () =>
    test.mutate(entry.id, {
      onSuccess: (r) =>
        toast(
          r.ok
            ? `reachable${r.egressIp ? ` · egress ${r.egressIp}` : ""} · ${r.elapsedMs ?? "?"}ms`
            : `failed: ${r.error ?? "unknown"}`,
          r.ok ? "success" : "error",
        ),
      onError: (err) => toastApiError(toast, err, "Test failed"),
    });

  return (
    <div className="flex items-center gap-2 py-1.5 text-[11px]">
      <StatusDot tone={!entry.enabled ? "gray" : cooling ? "yellow" : entry.lastTestOk === false ? "red" : entry.lastTestOk === true ? "green" : "gray"} className="size-1.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono text-text-muted" title={maskProxy(entry.url)}>
        {maskProxy(entry.url)}
      </span>
      {entry.egressIp && <span className="shrink-0 font-mono text-text-subtle" title="address the provider saw">{entry.egressIp}</span>}
      {cooling && (
        <Badge variant="warning" size="sm">
          cooling {minutesLeft}m{cooling.node ? ` · ${cooling.node}` : ""}
        </Badge>
      )}
      {!entry.enabled && <Badge size="sm">off</Badge>}
      <Button size="sm" variant="ghost" icon={<WifiHigh size={12} />} loading={test.isPending} onClick={runTest} aria-label="Test exit" />
      <Button
        size="sm"
        variant="ghost"
        aria-label={entry.enabled ? "Disable exit" : "Enable exit"}
        loading={update.isPending}
        onClick={() => update.mutate({ id: entry.id, patch: { enabled: !entry.enabled } }, { onError: (err) => toastApiError(toast, err, "Toggle failed") })}
      >
        {entry.enabled ? "off" : "on"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Remove exit"
        className="hover:bg-danger/10 hover:text-danger"
        icon={<Trash size={12} />}
        onClick={() => remove.mutate(entry.id, { onSuccess: () => toast("Exit removed"), onError: (err) => toastApiError(toast, err, "Delete failed") })}
      />
    </div>
  );
}

function AddExitsModal({ pool, isOpen, onClose }: { pool: ProxyPool; isOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const add = useAddPoolEntries();
  const [text, setText] = useState("");

  const lines = text
    .split(/[\r\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const unique = new Set(lines);

  const submit = () =>
    add.mutate(
      { id: pool.id, urls: text },
      {
        onSuccess: (r) => {
          // Say what landed, not that the call worked: a paste of 50 that added 3 is not a
          // success the user can read as one.
          const bits = [`${r.added} added`];
          if (r.skipped) bits.push(`${r.skipped} already there`);
          if (r.rejected.length) bits.push(`${r.rejected.length} not urls`);
          toast(bits.join(" · "), r.added ? "success" : "error");
          if (r.added) onClose();
        },
        onError: (err) => toastApiError(toast, err, "Add failed"),
      },
    );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Add exits to ${pool.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Plus size={15} />} disabled={lines.length === 0} loading={add.isPending} onClick={submit}>
            Add {unique.size} exit{unique.size === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <PasteUrls
          label="Proxy URLs — one per line"
          value={text}
          onChange={setText}
          rows={8}
          hint="Paste from the provider. A URL already in this pool is skipped, not duplicated."
        />
        {lines.length > 0 && unique.size < lines.length && (
          <p className="text-[11px] text-text-subtle">{lines.length - unique.size} line(s) in the paste repeat each other</p>
        )}
      </div>
    </Modal>
  );
}

function CreatePoolModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreatePool();
  const [name, setName] = useState("");
  const [urls, setUrls] = useState("");
  const [strict, setStrict] = useState(true);

  const count = new Set(urls.split(/[\r\n,]+/).map((l) => l.trim()).filter(Boolean)).size;
  const canSave = name.trim().length > 0;

  const submit = () =>
    create.mutate(
      { name: name.trim(), config: { strict }, urls },
      {
        onSuccess: (pool) => {
          toast(
            pool.exitCount ? `Pool created with ${pool.exitCount} exit(s)` : "Pool created — add exits before binding it",
            pool.exitCount ? "success" : "warning",
          );
          onClose();
        },
        onError: (err) => toastApiError(toast, err, "Create failed"),
      },
    );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New Proxy Pool"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Plus size={15} />} disabled={!canSave} loading={create.isPending} onClick={submit}>
            {count > 0 ? `Create Pool + ${count} exit${count === 1 ? "" : "s"}` : "Create Pool"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="residential" />
        <PasteUrls
          label="Proxy URLs — one per line (optional now)"
          value={urls}
          onChange={setUrls}
          rows={6}
          hint="Every line is one exit. Rotation spreads requests across them, so the upstream sees many addresses."
        />
        <Toggle
          label="Strict — fail instead of falling back to a direct request"
          hint={
            strict
              ? "A request that cannot go through the fleet fails. Recommended: a silent direct request leaks your real address."
              : "If every exit fails, the request is retried without a proxy. Your real address becomes visible to the provider."
          }
          checked={strict}
          onChange={setStrict}
        />
      </div>
    </Modal>
  );
}

function MergeModal({ pool, pools, isOpen, onClose }: { pool: ProxyPool; pools: ProxyPool[]; isOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const merge = useMergePools();
  const [picked, setPicked] = useState<string[]>([]);
  const others = pools.filter((p) => p.id !== pool.id);

  const submit = () =>
    merge.mutate(
      { targetId: pool.id, poolIds: picked },
      {
        onSuccess: (merged) => {
          toast(`Merged into ${merged.name} — ${merged.exitCount} exit(s); bindings moved`, "success");
          onClose();
        },
        onError: (err) => toastApiError(toast, err, "Merge failed"),
      },
    );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Merge into ${pool.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={picked.length === 0} loading={merge.isPending} onClick={submit}>
            Merge {picked.length} pool(s)
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-xs text-text-muted">
          Exits move into <span className="font-medium">{pool.name}</span>; providers and keys bound to a merged
          pool are rewritten to point here, so nothing silently loses its route.
        </p>
        {others.length === 0 && <p className="text-xs text-text-subtle">There is no other pool to merge.</p>}
        {others.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={picked.includes(p.id)}
              onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((id) => id !== p.id)))}
            />
            <span className="font-medium">{p.name}</span>
            <span className="text-text-subtle">{p.exitCount} exit(s)</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function PoolCard({ pool, pools }: { pool: ProxyPool; pools: ProxyPool[] }) {
  const toast = useToast();
  const testPool = useTestPool();
  const resetHealth = useResetPoolHealth();
  const update = useUpdatePool();
  const remove = useDeletePool();
  const [adding, setAdding] = useState(false);
  const [merging, setMerging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameDraft, setNameDraft] = useState(pool.name);
  const [result, setResult] = useState<PoolTestResult | null>(null);

  const entries = pool.entries ?? [];
  const shown = showAll ? entries : entries.slice(0, 6);

  const runTest = () =>
    testPool.mutate(pool.id, {
      onSuccess: (r) => {
        setResult(r);
        toast(
          `${r.healthy}/${r.tested} exit(s) reachable${r.entries.some((e) => e.egressIp) ? ` · ${new Set(r.entries.map((e) => e.egressIp).filter(Boolean)).size} address(es)` : ""}`,
          r.healthy > 0 ? "success" : "error",
        );
      },
      onError: (err) => toastApiError(toast, err, "Test failed"),
    });

  const runReset = () =>
    resetHealth.mutate(pool.id, {
      onSuccess: (r) => toast(r.cleared ? `${r.cleared} exit(s) back in rotation` : "nothing was cooling", "success"),
      onError: (err) => toastApiError(toast, err, "Reset failed"),
    });

  const saveName = () => {
    const name = nameDraft.trim();
    if (!name || name === pool.name) return setEditing(false);
    update.mutate({ id: pool.id, patch: { name } }, {
      onSuccess: () => { toast("Pool renamed"); setEditing(false); },
      onError: (err) => toastApiError(toast, err, "Rename failed"),
    });
  };

  return (
    <Card padding="sm" className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusDot tone={pool.enabled ? "green" : "gray"} />
          {editing ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              inputClassName="h-7 text-sm"
              className="w-40"
            />
          ) : (
            <button
              type="button"
              className="min-w-0 break-words text-sm font-semibold text-text-main hover:underline sm:truncate"
              title={`${pool.name} — click to rename`}
              onClick={() => setEditing(true)}
            >
              {pool.name}
            </button>
          )}
          <Badge variant={pool.exitCount === 0 ? "warning" : pool.testStatus === "active" ? "success" : pool.testStatus === "error" ? "error" : "default"} size="sm">
            {pool.exitCount === 0 ? "no exits" : pool.testStatus === "active" ? "reachable" : pool.testStatus === "error" ? "failing" : "untested"}
          </Badge>
          {pool.config?.strict === false && (
            <span title="If every exit fails, the request goes direct — the provider sees your real address">
              <Badge variant="warning" size="sm">not strict</Badge>
            </span>
          )}
          <span className="text-[11px] text-text-subtle tabular">
            {pool.enabledCount}/{pool.exitCount} exits
            {pool.coolingCount > 0 && <span className="text-warning"> · {pool.coolingCount} cooling</span>}
            {pool.egressIpCount > 0 && <> · {pool.egressIpCount} address{pool.egressIpCount === 1 ? "" : "es"}</>}
          </span>
          {!!pool.boundCount && <span className="text-[11px] text-text-subtle tabular">· bound to {pool.boundCount}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" icon={<WifiHigh size={13} />} loading={testPool.isPending} onClick={runTest}>
            Test
          </Button>
          <Button size="sm" variant="ghost" onClick={runReset} loading={resetHealth.isPending} title="Put every exit back in rotation">
            Re-enable
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMerging(true)} title="Merge other pools into this one">
            Merge
          </Button>
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

      <div className="flex min-h-8 flex-col border-t border-border-subtle pt-1">
        {entries.length === 0 && (
          <p className="py-2 text-[11px] text-text-subtle">
            No exits yet — a provider bound to this pool cannot send requests until there is at least one.
          </p>
        )}
        {shown.map((e) => (
          <ExitRow key={e.id} entry={e} />
        ))}
        {entries.length > 6 && (
          <button
            type="button"
            className="flex items-center gap-1 py-1 text-[11px] text-text-subtle hover:text-text-main"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "collapse" : `show all ${entries.length} exits`}
          </button>
        )}
        <Button size="sm" variant="ghost" className="mt-1 self-start" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
          Add exits
        </Button>
      </div>

      <Toggle
        label="Enabled"
        hint={pool.enabled ? "Providers and keys may draw from this fleet" : "Excluded from routing"}
        checked={pool.enabled}
        loading={update.isPending}
        onChange={(enabled) => update.mutate({ id: pool.id, patch: { enabled } }, { onError: (err) => toastApiError(toast, err, "Toggle failed") })}
      />

      {(result || pool.lastError) && (
        <div className="flex items-start gap-2 border-t border-border-subtle pt-2 font-mono text-[11px]">
          {result ? (result.healthy > 0 ? <StatusDot tone="green" className="mt-1 size-1.5" /> : <XCircle size={12} className="shrink-0 text-danger" />): <XCircle size={12} className="shrink-0 text-danger" />}
          <span className="min-w-0 flex-1 break-words text-text-muted">
            {result
              ? `${result.healthy}/${result.tested} reachable`
              : (pool.lastError ?? "the last check failed")}
          </span>
        </div>
      )}

      <p className="text-[11px] text-text-subtle">
        {pool.lastTestedAt ? `checked ${fmtDateTime(pool.lastTestedAt)} · ` : "never checked · "}
        updated {fmtDateTime(pool.updatedAt)}
      </p>

      {adding && <AddExitsModal pool={pool} isOpen={adding} onClose={() => setAdding(false)} />}
      {merging && <MergeModal pool={pool} pools={pools} isOpen={merging} onClose={() => setMerging(false)} />}
      <Modal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${pool.name}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() =>
                remove.mutate(pool.id, {
                  onSuccess: () => { toast("Pool deleted"); setConfirmDelete(false); },
                  onError: (err) => toastApiError(toast, err, "Delete failed"),
                })
              }
            >
              Delete Pool
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Its {pool.exitCount} exit(s) go with it.
          {pool.boundCount ? ` ${pool.boundCount} binding(s) will fall back to no proxy — merge them in instead if that is not what you want.` : ""}
        </p>
      </Modal>
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
          A pool is a fleet of proxy exits. Rotation spreads requests across them so the upstream sees many
          addresses; an exit that fails or is rate-limited leaves the rotation until it recovers.
        </p>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New Pool
        </Button>
      </div>

      {pools.isLoading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}

      {pools.data?.length === 0 && !pools.isLoading && (
        <Card padding="sm">
          <p className="text-sm text-text-muted">
            No pools yet. Add one and paste your proxy URLs, then bind it on a provider's Settings tab.
          </p>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {(pools.data ?? []).map((pool) => (
          <PoolCard key={pool.id} pool={pool} pools={pools.data ?? []} />
        ))}
      </div>

      {creating && <CreatePoolModal isOpen={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}
