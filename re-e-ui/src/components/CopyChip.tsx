import { useState } from "react";
import { Check, Copy } from "./icons";
import { cn } from "../utils/cn";

/**
 * Masked value + one-click copy. Keys arrive pre-masked from the API, so what a
 * user can copy here is only ever the masked form or a public endpoint URL.
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
  const [copied, setCopied] = useState(false);
  const target = copyValue ?? value;
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(target).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={`Copy ${target}`}
      className={cn(
        "inline-flex h-7 max-w-[300px] items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5",
        "font-mono text-xs text-text-main transition-colors hover:border-brand-500/40",
        className,
      )}
    >
      {copied ? (
        <Check size={14} className="shrink-0 text-success" />
      ) : (
        <Copy size={14} className="shrink-0 text-text-muted" />
      )}
      {label && <span className="shrink-0 text-text-muted">{label}</span>}
      <span className="truncate">{value}</span>
    </button>
  );
}
