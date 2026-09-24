import { Check, Copy, Warning } from "../icons";
import { cn } from "../../utils/cn";
import { COPY_FAILED_HINT, useCopy } from "../../hooks/useCopy";

/**
 * Copy-to-clipboard icon button with a brief confirmation tick.
 * Stops propagation because table rows are themselves clickable.
 *
 * The tick only appears once the value is provably on the clipboard: see useCopy.
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
  const { state, copy } = useCopy();
  const label = state === "fail" ? COPY_FAILED_HINT : title ?? `Copy ${value}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void copy(value);
      }}
      className={cn(
        "shrink-0 rounded-[6px] p-1 text-text-subtle transition-colors hover:text-text-main",
        className,
      )}
    >
      {state === "ok" ? (
        <Check size={size} className="text-success" />
      ) : state === "fail" ? (
        <Warning size={size} className="text-danger" />
      ) : (
        <Copy size={size} />
      )}
    </button>
  );
}
