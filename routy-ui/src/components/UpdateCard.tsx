import { useState } from "react";
import { useApplyUpdate, useCheckUpdates, useDismissUpdate, useUpdates } from "../api/hooks";
import { toastApiError } from "../utils/errors";
import { fmtAgo } from "../utils/format";
import { ArrowCircleUp, Check, X } from "./icons";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Skeleton } from "./ui/Skeleton";
import { useToast } from "./ui/Toast";

/**
 * "A new release is out" — shown only when there is one.
 *
 * Three deliberate choices:
 *  · It never installs on its own. A self-updating binary that acts without a click
 *    is a remote code execution channel; the click is the consent.
 *  · Dismissal is per version, so silencing 0.2.0 does not also silence 0.3.0.
 *  · When the release has no signed archive attached, there is no button at all —
 *    a link to the release page instead of a control that would fail.
 */
export function UpdateCard() {
  const toast = useToast();
  const updates = useUpdates();
  const check = useCheckUpdates();
  const dismiss = useDismissUpdate();
  const apply = useApplyUpdate();
  const [confirming, setConfirming] = useState(false);

  const s = updates.data;

  // Nothing to say: no update at all, or checks are turned off.
  if (updates.isLoading) return null;
  if (!s) return null;
  if (s.enabled === false) return null;
  if (!s.available) return null;

  // Hidden is not gone. The card is the only place with a "Check again" and the only
  // thing you'd look at, so making the X delete it turns one stray click into an
  // unrecoverable silence — you cannot reveal a control that only exists inside the
  // thing you hid. A dismissed notice therefore collapses to one quiet line here
  // instead of vanishing, and that line is the way back.
  if (s.dismissed === s.latest) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-[11px] text-text-subtle">
        <ArrowCircleUp size={13} weight="thin" />
        <span>
          v{s.latest} is available — you hid this notice
        </span>
        <button
          onClick={() =>
            dismiss.mutate(null, {
              onSuccess: () => toast(`v${s.latest} will be offered again`),
              onError: (e) => toastApiError(toast, e, "Failed to show it again"),
            })
          }
          className="ml-auto shrink-0 text-info underline"
          title="Show the update card again"
        >
          Show
        </button>
      </div>
    );
  }

  const install = () =>
    apply.mutate(undefined, {
      onSuccess: (r) => {
        setConfirming(false);
        toast(r.restarting ? `v${r.version} installed — restarting` : `v${r.version} installed`);
      },
      onError: (err) => {
        setConfirming(false);
        toastApiError(toast, err, "Update failed");
      },
    });

  return (
    <Card padding="sm" className="flex flex-col gap-3 border-info/30 bg-info/5">
      <div className="flex flex-wrap items-center gap-2">
        <ArrowCircleUp size={16} weight="fill" className="text-info" />
        <h3 className="text-sm font-semibold text-text-main">
          routy v{s.latest} is available
        </h3>
        <Badge variant="info" size="sm">
          you have v{s.current}
        </Badge>
        <button
          onClick={() => dismiss.mutate(s.latest, { onError: (e) => toastApiError(toast, e, "Failed to dismiss") })}
          aria-label={`Dismiss the v${s.latest} notice`}
          title="Hide this release — bring it back any time in Settings → Updates"
          className="ml-auto rounded-md p-1 text-text-subtle transition-colors hover:bg-surface-2 hover:text-text-main"
        >
          <X size={14} />
        </button>
      </div>

      {s.notes && (
        <pre className="max-h-40 overflow-y-auto custom-scrollbar whitespace-pre-wrap rounded-[8px] border border-border-subtle bg-surface-2 p-3 font-sans text-xs text-text-muted">
          {s.notes}
        </pre>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {s.assetsReady ? (
          confirming ? (
            <>
              <Button variant="primary" size="sm" loading={apply.isPending} onClick={install}>
                Install v{s.latest} and restart
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={apply.isPending}>
                Cancel
              </Button>
              <span className="text-[11px] text-text-subtle">
                In-flight requests drain first; the gateway restarts itself.
              </span>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" icon={<ArrowCircleUp size={13} />} onClick={() => setConfirming(true)}>
                Update to v{s.latest}
              </Button>
              {s.url && (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-text-muted underline decoration-border underline-offset-2 hover:text-text-main"
                >
                  release notes
                </a>
              )}
            </>
          )
        ) : (
          <span className="text-[11px] text-text-muted">
            This release has no signed archive attached, so it cannot be installed from here.
            {s.url && (
              <>
                {" "}
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-border underline-offset-2 hover:text-text-main"
                >
                  Open the release page
                </a>
              </>
            )}
          </span>
        )}

        <span className="ml-auto flex items-center gap-2 text-[11px] text-text-subtle">
          {s.checkedAt && <>checked {fmtAgo(s.checkedAt)}</>}
          <Button
            variant="ghost"
            size="sm"
            icon={<Check size={12} />}
            loading={check.isPending}
            onClick={() =>
              check.mutate(undefined, {
                onSuccess: (r) => toast(r.available ? `v${r.latest} available` : "You are up to date"),
                onError: (err) => toastApiError(toast, err, "Check failed"),
              })
            }
          >
            Check again
          </Button>
        </span>
      </div>
    </Card>
  );
}

/** Skeleton used while the first check is in flight, so the card does not pop in. */
export const UpdateCardLoading = () => <Skeleton rows={1} />;
