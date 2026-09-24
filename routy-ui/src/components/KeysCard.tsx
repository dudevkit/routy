import { useState } from "react";
import { useCreateKey, useKeys, useRemoveKey, useSetKeyEnabled } from "../api/hooks";
import { toastApiError } from "../utils/errors";
import { fmtAgo, fmtDateTime } from "../utils/format";
import { Check, Copy, Key as KeyIcon, Plus, Prohibit, Trash, Warning } from "./icons";
import { Badge } from "./ui/Badge";
import { COPY_FAILED_HINT, useCopy } from "../hooks/useCopy";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { Skeleton } from "./ui/Skeleton";
import { useToast } from "./ui/Toast";
import { cn } from "../utils/cn";

/**
 * Mask a key for display. The full value is still one click away, because the
 * dashboard is where these keys live — masking is about not spraying a live
 * credential across a screen, not about hiding it from its owner.
 */
function mask(key: string): string {
  if (key.length <= 14) return key;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function KeyChip({ value }: { value: string | null }) {
  const { state, copy } = useCopy();
  if (!value) {
    return (
      <span className="font-mono text-[11px] text-text-subtle" title="Created before keys were kept — delete and create a new one to get a copyable key">
        not kept
      </span>
    );
  }
  return (
    <button
      onClick={() => void copy(value)}
      title={state === "fail" ? COPY_FAILED_HINT : `Copy the full key (${mask(value)})`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1",
        "font-mono text-[11px] text-text-main transition-colors hover:border-brand-500/40",
      )}
    >
      {state === "ok" ? <Check size={13} className="shrink-0 text-success" /> : state === "fail" ? <Warning size={13} className="shrink-0 text-danger" /> : <Copy size={13} className="shrink-0 text-text-muted" />}
      <span className="selectable">{mask(value)}</span>
    </button>
  );
}

/**
 * Client API keys — create, copy and revoke. Lives on the Overview because this
 * is the page you land on and the place keys are kept; the create flow used to
 * sit behind Settings and showed the plaintext exactly once, which meant losing
 * the key if you did not paste it somewhere immediately.
 */
export function KeysCard() {
  const toast = useToast();
  const keys = useKeys();
  const createKey = useCreateKey();
  const removeKey = useRemoveKey();
  const setKeyEnabled = useSetKeyEnabled();
  const [name, setName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const list = keys.data ?? [];

  const create = (label?: string) =>
    createKey.mutate(label, {
      onSuccess: (res) => {
        setName("");
        toast(res.key ? `Key created — copy it with the ${mask(res.key)} chip` : "Key created");
      },
      onError: (err) => toastApiError(toast, err, "Failed to create key"),
    });

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyIcon size={16} className="text-text-muted" />
          <h3 className="text-sm font-semibold text-text-main">Client API keys</h3>
          <Badge variant="default" size="sm">
            {list.length}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="label (optional)"
            className="w-44"
            inputClassName="h-8 py-0 text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") create(name.trim() || undefined);
            }}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<Plus size={13} />}
            loading={createKey.isPending}
            onClick={() => create(name.trim() || undefined)}
          >
            Create Key
          </Button>
        </div>
      </div>

      {keys.isLoading ? (
        <Skeleton rows={2} />
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border px-4 py-10 text-center">
          <KeyIcon size={28} className="text-text-subtle" />
          <p className="text-sm text-text-muted">No client keys yet.</p>
          <p className="max-w-sm text-xs text-text-subtle">
            Keys gate the <span className="font-mono text-text-main">/v1</span> proxy. Create one when you want
            per-app credentials instead of an open local gateway.
          </p>
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="bg-bg-alt text-left">
              <th className="px-3 py-1.5 text-[11px] font-medium text-text-muted">Label</th>
              <th className="px-3 py-1.5 text-[11px] font-medium text-text-muted">Key</th>
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
                <td className="px-3 py-2">
                  <KeyChip value={k.key} />
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
        Click a key to copy the full value. Revoking keeps the row (and its usage history) so you can re-enable it
        later; deleting erases it.
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
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Any client using this key stops working immediately. This cannot be undone.
        </p>
      </Modal>
    </Card>
  );
}
