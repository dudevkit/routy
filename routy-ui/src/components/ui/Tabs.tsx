import { cn } from "../../utils/cn";

export interface TabSpec {
  value: string;
  label: string;
}

/** Upstream SegmentedControl pattern — used for the Usage tabs. */
export function Tabs({
  value,
  onChange,
  items,
  size = "md",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  items: TabSpec[];
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-[10px] border border-border-subtle bg-surface-2 p-1",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              "rounded-[7px] font-semibold transition-all duration-150",
              size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
              active
                ? "bg-surface text-text-main shadow-[var(--shadow-soft)]"
                : "text-text-muted hover:text-text-main",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
