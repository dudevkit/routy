import { useState } from "react";
import { Check, Copy } from "../icons";
import { cn } from "../../utils/cn";

/**
 * Copy-to-clipboard icon button with a brief confirmation tick.
 * Stops propagation because table rows are themselves clickable.
 */
export function CopyButton({
  value,
  title,
  size = 13,
  className,
}: {
  value: string;
  /** defaults to "Copy <value>" — pass a clearer one when the value is long */
  title?: string;
  size?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const label = title ?? `Copy ${value}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={cn(
        "shrink-0 rounded-[6px] p-1 text-text-subtle transition-colors hover:text-text-main",
        className,
      )}
    >
      {copied ? <Check size={size} className="text-success" /> : <Copy size={size} />}
    </button>
  );
}
