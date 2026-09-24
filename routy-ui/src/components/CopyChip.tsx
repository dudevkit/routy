import { Check, Copy, Warning } from "./icons";
import { cn } from "../utils/cn";
import { COPY_FAILED_HINT, useCopy } from "../hooks/useCopy";

/**
 * Masked value + one-click copy. Keys arrive pre-masked from the API, so what a
 * user can copy here is only ever the masked form or a public endpoint URL.
 *
 * `selectable` on the value: this is a button, and the stylesheet turns text
 * selection off for buttons. When both clipboard paths are unavailable that would
 * leave no way at all to get an endpoint or a key out of the dashboard.
 */
export function CopyChip({
  value,
  className,
  copyValue,
  label,
}: {
  value: string;
  className?: string;
  /** copy this instead of what's shown (e.g. full endpoint, masked display) */
  copyValue?: string;
  label?: string;
}) {
  const { state, copy } = useCopy();
  const target = copyValue ?? value;
  const hint = state === "fail" ? COPY_FAILED_HINT : `Copy ${target}`;
  return (
    <button
      onClick={() => void copy(target)}
      title={hint}
      aria-label={hint}
      className={cn(
        "inline-flex h-7 max-w-[300px] min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5",
        "font-mono text-xs text-text-main transition-colors hover:border-brand-500/40",
        className,
      )}
    >
      {state === "ok" ? (
        <Check size={14} className="shrink-0 text-success" />
      ) : state === "fail" ? (
        <Warning size={14} className="shrink-0 text-danger" />
      ) : (
        <Copy size={14} className="shrink-0 text-text-muted" />
      )}
      {label && <span className="shrink-0 text-text-muted">{label}</span>}
      <span className="selectable truncate">{value}</span>
    </button>
  );
}
