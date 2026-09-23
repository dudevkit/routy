import { useState } from "react";
import { useCreateKey, useGateway, useHealth, useKeys, usePutSettings, useRemoveKey, useSetKeyEnabled, useSettings, useStats } from "../api/hooks";
import type { CreatedApiKey } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtAgo, fmtCost, fmtDateTime } from "../utils/format";
import { Check, Key as KeyIcon, Plus, Prohibit, Trash } from "../components/icons";
import { CopyChip } from "../components/CopyChip";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { ThemeToggle } from "../components/ui/ThemeToggle";
import { Toggle } from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

function fmtUptime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The show-once moment: the backend returns the plaintext key exactly here plus a
 * `warning` field. Rendered large and copyable, and unrecoverable once dismissed.
 */
function ShowOncePanel({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-warning/40 bg-warning/10 p-4">
      <div>
        <p className="text-sm font-semibold text-text-main">Copy this key now</p>
        <p className="mt-0.5 text-xs text-text-muted">{created.warning}</p>
      </div>
      <CopyChip value={created.key} className="max-w-full text-[13px]" />
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-text-subtle">#{created.id.slice(0, 8)}</span>
        <Button variant="primary" size="sm" onClick={onDone}>
          I stored it
        </Button>
      </div>
    </div>
  );
}

function KeysCard() {
  const toast = useToast();
  const keys = useKeys();
  const createKey = useCreateKey();
  const removeKey = useRemoveKey();
  const setKeyEnabled = useSetKeyEnabled();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [name, setName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const list = keys.data ?? [];

  const create = (label?: string) =>
    createKey.mutate(label, {
      onSuccess: (res) => setCreated(res),
      onError: (err) => toastApiError(toast, err, "Failed to create key"),
    });

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyIcon size={16} className="text-text-muted" />
          <h3 className="text-sm font-semibold text-text-main">Client API keys</h3>
          <Badge variant="default" size="sm">
            {list.length}
          </Badge>
        </div>
        {list.length > 0 && (
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="label"
              className="w-36"
              inputClassName="h-8 py-0 text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={13} />}
              loading={createKey.isPending}
              onClick={() => create(name.trim() || undefined)}
            >
              Create
            </Button>
          </div>
        )}
      </div>

      {created && <ShowOncePanel created={created} onDone={() => setCreated(null)} />}

      {keys.isLoading ? (
        <Skeleton rows={2} />
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border px-4 py-10 text-center">
          <KeyIcon size={28} className="text-text-subtle" />
          <p className="text-sm text-muted text-text-muted">No client keys yet.</p>
          <p className="max-w-sm text-xs text-text-subtle">
            Keys gate the <span className="font-mono text-text-main">/v1</span> proxy. Create one when you want
            per-app credentials instead of an open local gateway.
          </p>
          <Button variant="primary" size="sm" icon={<Plus size={13} />} loading={createKey.isPending} onClick={() => create(undefined)}>
            Create Key
          </Button>
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="bg-bg-alt text-left">
              <th className="px-3 py-1.5 text-[11px] font-medium text-text-muted">Label</th>
              <th className="px-3 py-1.5 text-[11px] font-medium text-text-muted">Created</th>
              <th className="px-3 py-1.5 text-[11px] font-medium text-text-muted">Last used</th>
              <th className="px-3 py-1.5 text-right text-[11px] font-medium text-text-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((k) => (
              <tr key={k.id} className="border-t border-border-subtle">
                <td className="px-3 py-2 text-xs font-medium text-text-main">
                  <span className="flex items-center gap-2">
                    {k.name || <span className="text-text-subtle">unlabeled</span>}
                    {!k.enabled && (
                      <Badge variant="default" size="sm">
                        disabled
                      </Badge>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-text-muted">{fmtDateTime(k.createdAt)}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-text-muted">
                  {k.lastUsedAt ? fmtAgo(k.lastUsedAt) : "never"}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={k.enabled ? `Revoke key ${k.name ?? k.id}` : `Re-enable key ${k.name ?? k.id}`}
                      icon={k.enabled ? <Prohibit size={13} /> : <Check size={13} />}
                      disabled={setKeyEnabled.isPending}
                      onClick={() =>
                        setKeyEnabled.mutate(
                          { id: k.id, enabled: !k.enabled },
                          {
                            onSuccess: () => toast(k.enabled ? "Key revoked" : "Key re-enabled"),
                            onError: (err) => toastApiError(toast, err, "Failed to update key"),
                          },
                        )
                      }
                    >
                      {k.enabled ? "Revoke" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete key ${k.name ?? k.id}`}
                      className="hover:bg-danger/10 hover:text-danger"
                      icon={<Trash size={13} />}
                      onClick={() => setConfirmId(k.id)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-[11px] text-text-subtle">
        Keys are stored hashed — the plaintext exists only in the panel above, once. Revoking keeps the row (and its
        usage history) so you can re-enable it later; deleting erases it.
      </p>

      <Modal
        isOpen={!!confirmId}
        onClose={() => setConfirmId(null)}
        title="Delete API key?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                confirmId &&
                removeKey.mutate(confirmId, {
                  onSuccess: () => {
                    toast("Key deleted");
                    setConfirmId(null);
                  },
                  onError: (err) => toastApiError(toast, err, "Delete failed"),
                })
              }
            >
              Delete Key
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Clients using it start failing with <span className="font-mono text-text-main">auth_error</span> immediately.
        </p>
      </Modal>
    </Card>
  );
}

/**
 * Metered spend against the daily ceiling. Enforcement lives in the gateway, so
 * this card only mirrors it — today's spend comes from the same counter the
 * router blocks on, which keeps the two from disagreeing.
 */
function SpendCard() {
  const toast = useToast();
  const settings = useSettings();
  const stats = useStats();
  const put = usePutSettings();

  const limit = Number(settings.data?.budgetUsdPerDay) || 0;
  const spent = stats.data?.costUsdToday ?? 0;
  const over = limit > 0 && spent >= limit;
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;

  const commit = (raw: string) => {
    const value = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value === limit) return;
    put.mutate(
      { budgetUsdPerDay: value },
      {
        onSuccess: () => toast(value > 0 ? `Daily budget set to $${value}` : "Daily budget removed — unmetered"),
        onError: (err) => toastApiError(toast, err, "Failed to save budget"),
      },
    );
  };

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Spend</h3>
          <p className="text-[11px] text-text-muted">
            Metered spend since midnight. Upstreams with no price are unmetered, so they keep serving after the
            ceiling — add a price per node to include it.
          </p>
        </div>
        <Badge variant={over ? "error" : limit > 0 ? "success" : "default"} size="sm">
          {over ? "ceiling reached" : limit > 0 ? "within budget" : "unmetered"}
        </Badge>
      </div>

      <div className="flex flex-wrap items-end gap-5">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-text-muted">Spent today</span>
          <span className="font-mono text-sm text-text-main tabular">{fmtCost(spent)}</span>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-muted">Daily budget (USD)</span>
          <input
            key={limit}
            type="number"
            min={0}
            step="0.01"
            placeholder="unlimited"
            defaultValue={limit > 0 ? String(limit) : ""}
            disabled={put.isPending}
            onBlur={(e) => commit(e.target.value)}
            className="w-32 rounded-[6px] border border-border-subtle bg-bg px-2 py-1 font-mono text-xs text-text-main"
          />
        </label>
      </div>

      {limit > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
          <div className={over ? "h-full bg-danger" : "h-full bg-accent"} style={{ width: `${pct}%` }} />
        </div>
      )}
    </Card>
  );
}

export function Settings() {
  const toast = useToast();
  const gateway = useGateway();
  const health = useHealth();
  const settings = useSettings();
  const put = usePutSettings();

  const requireApiKey = settings.data?.requireApiKey === true;
  const setRequireApiKey = (enabled: boolean) =>
    put.mutate({ requireApiKey: enabled }, { onError: (err) => toastApiError(toast, err, "Failed to save setting") });

  return (
    <div className="flex flex-col gap-4">
      <Card padding="sm" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-text-main">Gateway</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Proxy endpoint</span>
            {gateway.data ? <CopyChip value={gateway.data.endpoint} /> : <Skeleton rows={1} />}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Router key</span>
            {gateway.data ? <CopyChip value={gateway.data.keyMasked} /> : <Skeleton rows={1} />}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Version · uptime</span>
            <span className="font-mono text-xs text-text-main tabular">
              {gateway.data?.version ?? "—"} · {health.data ? fmtUptime(health.data.uptimeMs) : "—"}
            </span>
          </div>
        </div>
      </Card>

      <Card padding="sm" className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-text-main">Access</h3>
        {settings.isLoading ? (
          <Skeleton rows={1} />
        ) : (
          <Toggle
            label="Require a client API key for /v1"
            hint={
              requireApiKey
                ? "Requests without a valid key get auth_error. This UI still works — it is same-origin on loopback."
                : "Open local gateway: any local client can route. Turn it on once you have minted keys."
            }
            checked={requireApiKey}
            loading={put.isPending}
            onChange={setRequireApiKey}
          />
        )}
      </Card>

      <KeysCard />

      <SpendCard />

      <Card padding="sm" className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Appearance</h3>
          <p className="text-[11px] text-text-muted">Graphite Pro ships dark-first; light is the same tokens, retuned.</p>
        </div>
        <ThemeToggle variant="card" />
      </Card>
    </div>
  );
}
