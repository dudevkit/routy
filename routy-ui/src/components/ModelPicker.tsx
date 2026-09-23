import { useMemo, useState } from "react";
import { useRoutableModels } from "../api/hooks";
import { Check, MagnifyingGlass } from "./icons";
import { Badge } from "./ui/Badge";
import { Input } from "./ui/Input";
import { Skeleton } from "./ui/Skeleton";
import { cn } from "../utils/cn";

/**
 * Pick a routable model, grouped by the provider that serves it.
 *
 * Ids are `<prefix>/<model>` and a model can itself contain slashes
 * (`gonka/MiniMaxAI/MiniMax-M2.7`), so the provider is the FIRST segment only.
 * Aliases and combos have no provider and are grouped under their own heading —
 * they are still routable, and often the better choice.
 */
export function groupModels(ids: string[]): { provider: string; models: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const slash = id.indexOf("/");
    const provider = slash === -1 ? "aliases & combos" : id.slice(0, slash);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider)!.push(id);
  }
  return [...groups.entries()]
    .map(([provider, models]) => ({ provider, models: models.sort() }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function ModelPicker({
  value,
  onChange,
  emptyHint,
}: {
  value: string | null;
  onChange: (model: string) => void;
  emptyHint?: string;
}) {
  const models = useRoutableModels();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const all = models.data ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((id) => id.toLowerCase().includes(q)) : all;
    return groupModels(filtered);
  }, [models.data, query]);

  const total = models.data?.length ?? 0;
  const shown = groups.reduce((n, g) => n + g.models.length, 0);

  if (models.isLoading) return <Skeleton rows={3} />;

  if (total === 0) {
    return (
      <p className="text-xs text-text-muted">
        {emptyHint ?? "No routable models yet — add a provider and import its models first."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${total} models…`}
        icon={<MagnifyingGlass size={14} />}
        inputClassName="h-9 py-0 text-xs"
      />

      <div className="max-h-64 overflow-y-auto custom-scrollbar rounded-[8px] border border-border-subtle bg-surface-2/40">
        {shown === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-text-subtle">Nothing matches “{query}”.</p>
        ) : (
          groups.map((group) => (
            <div key={group.provider}>
              <div className="sticky top-0 flex items-center gap-2 border-b border-border-subtle bg-surface-2 px-3 py-1.5">
                <span className="font-mono text-[11px] font-semibold text-text-main">{group.provider}</span>
                <Badge variant="default" size="sm">{group.models.length}</Badge>
              </div>
              {group.models.map((id) => {
                const selected = id === value;
                // show the model part, since the provider is the heading
                const slash = id.indexOf("/");
                const label = slash === -1 ? id : id.slice(slash + 1);
                return (
                  <button
                    key={id}
                    onClick={() => onChange(id)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                      selected ? "bg-primary/10" : "hover:bg-surface-2",
                    )}
                  >
                    {selected ? (
                      <Check size={13} className="shrink-0 text-primary" />
                    ) : (
                      <span className="size-[13px] shrink-0" />
                    )}
                    <span className="truncate font-mono text-xs text-text-main" title={id}>
                      {label}
                    </span>
                    {/* the full routable id is what gets written, so show it plainly */}
                    {slash !== -1 && (
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-text-subtle">{group.provider}/</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      <p className="font-mono text-[11px] text-text-subtle">
        {value ? `will write: ${value}` : "no model selected"}
      </p>
    </div>
  );
}
