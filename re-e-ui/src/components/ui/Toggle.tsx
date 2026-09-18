import { cn } from "../../utils/cn";

/** Settings switch — accent when on, label left, control right. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  loading,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-main">{label}</p>
        {hint && <p className="text-xs text-text-muted">{hint}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled || loading}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150",
          checked ? "border-transparent bg-primary" : "border-border bg-surface-3",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-all duration-150",
            checked ? "left-[calc(100%-18px)]" : "left-[3px]",
          )}
        />
      </button>
    </div>
  );
}
