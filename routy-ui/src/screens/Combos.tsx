import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useAliases,
  useCombos,
  useCreateCombo,
  useDeleteAlias,
  useDeleteCombo,
  useSetAlias,
  useUpdateCombo,
} from "../api/hooks";
import type { Combo } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtDateTime } from "../utils/format";
import { ArrowDown, ArrowUp, List, Plus, Stack, Trash } from "../components/icons";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Skeleton } from "../components/ui/Skeleton";
import { useToast } from "../components/ui/Toast";
import { cn } from "../utils/cn";

/**
 * Routable names come from the management model list (aliases + combos + node
 * prefixes). `reachable` distinguishes "gateway answered, nothing to route yet"
 * from "list unavailable" (not signed in, or gateway down) — the copy must not
 * blame the gateway for an empty install, and must not hide a failure behind one.
 */
type ModelsState = { status: "loading" } | { status: "reachable"; models: string[] } | { status: "unreachable"; reason: string };

function useRoutableModels(): ModelsState {
  const [state, setState] = useState<ModelsState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then(async (res) => {
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error
              ? String((body.error as { message: unknown }).message)
              : `HTTP ${res.status}`;
          return { ok: false as const, message };
        }
        const data: unknown = await res.json();
        const list: unknown =
          data && typeof data === "object" && "data" in data ? (data as { data: unknown }).data : undefined;
        const ids: string[] = [];
        if (Array.isArray(list)) {
          for (const item of list) {
            if (typeof item === "object" && item !== null && "id" in item && typeof item.id === "string") ids.push(item.id);
          }
        }
        return { ok: true as const, ids: ids.sort() };
      })
      .then((result) => {
        if (cancelled) return;
        if (result.ok === true) setState({ status: "reachable", models: result.ids });
        else setState({ status: "unreachable", reason: result.message });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unreachable", reason: "network" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

const STRATEGIES = [
  { value: "fallback", label: "Fallback (in order)" },
  { value: "round-robin", label: "Round robin" },
  { value: "sticky", label: "Sticky until limit" },
];

function ModelRow({
  model,
  index,
  total,
  onMove,
  onRemove,
}: {
  model: string;
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${index}:${model}`,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-[8px] border border-border-subtle bg-surface-2 px-2 py-1.5",
        isDragging && "opacity-80 shadow-[var(--shadow-elev)]",
      )}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${model}`}
        className="cursor-grab rounded-[6px] p-1 text-text-subtle hover:text-text-main active:cursor-grabbing"
      >
        <List size={14} />
      </button>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-main">
        {model}
        {index === 0 && <span className="ml-2 text-[10px] text-primary">primary</span>}
      </span>
      <button
        aria-label={`Move ${model} up`}
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
        className="rounded-[6px] p-1 text-text-subtle transition-colors hover:text-text-main disabled:opacity-30"
      >
        <ArrowUp size={13} />
      </button>
      <button
        aria-label={`Move ${model} down`}
        disabled={index === total - 1}
        onClick={() => onMove(index, index + 1)}
        className="rounded-[6px] p-1 text-text-subtle transition-colors hover:text-text-main disabled:opacity-30"
      >
        <ArrowDown size={13} />
      </button>
      <button
        aria-label={`Remove ${model} from combo`}
        onClick={onRemove}
        className="rounded-[6px] p-1 text-text-subtle transition-colors hover:text-danger"
      >
        <Trash size={13} />
      </button>
    </div>
  );
}

function ComboCard({ combo, suggestions }: { combo: Combo; suggestions: string[] }) {
  const toast = useToast();
  const update = useUpdateCombo();
  const remove = useDeleteCombo();
  const [draft, setDraft] = useState<string[]>(combo.models);
  const [strategy, setStrategy] = useState(combo.strategy);
  const [stickyLimit, setStickyLimit] = useState(String(combo.stickyLimit));
  const [adding, setAdding] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(combo.models) ||
    strategy !== combo.strategy ||
    Number(stickyLimit) !== combo.stickyLimit;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const keys = draft.map((m, i) => `${i}:${m}`);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setDraft(arrayMove(draft, from, to));
  };

  const commit = () =>
    update.mutate(
      { id: combo.id, patch: { models: draft, strategy, stickyLimit: Math.max(1, Number(stickyLimit) || 1) } },
      {
        onSuccess: () => toast("Combo saved"),
        onError: (err) => toastApiError(toast, err, "Save failed"),
      },
    );

  const addModel = () => {
    const value = adding.trim();
    if (!value || draft.includes(value)) return;
    setDraft([...draft, value]);
    setAdding("");
  };

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-main">{combo.name}</h3>
            <Badge variant="primary" size="sm">
              {combo.models.length} models
            </Badge>
            {dirty && <Badge variant="warning" size="sm">unsaved</Badge>}
          </div>
          <p className="mt-0.5 text-[11px] text-text-subtle">updated {fmtDateTime(combo.updatedAt)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {dirty && (
            <Button size="sm" variant="primary" loading={update.isPending} onClick={commit}>
              Save
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete ${combo.name}`}
            className="hover:bg-danger/10 hover:text-danger"
            icon={<Trash size={13} />}
            onClick={() => setConfirmDelete(true)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Select label="Strategy" value={strategy} options={STRATEGIES} onChange={(e) => setStrategy(e.target.value)} />
        <Input
          label="Sticky limit"
          type="number"
          min={1}
          value={stickyLimit}
          onChange={(e) => setStickyLimit(e.target.value)}
          disabled={strategy !== "sticky"}
          inputClassName="font-mono tabular"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted">Route order · clients send the bare combo name; entries are tried top to bottom</span>
        {draft.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-border px-3 py-4 text-center text-xs text-text-subtle">
            Empty combo — add at least one model to route.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext items={keys} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1.5">
                {draft.map((m, i) => (
                  <ModelRow
                    key={keys[i]}
                    model={m}
                    index={i}
                    total={draft.length}
                    onMove={(from, to) => setDraft(arrayMove(draft, from, to))}
                    onRemove={() => setDraft(draft.filter((_, idx) => idx !== i))}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        <div className="mt-1 flex items-center gap-2">
          <Input
            mono
            list="routable-models"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addModel()}
            placeholder="prefix/model"
            inputClassName="h-8 py-0 text-xs"
            className="flex-1"
          />
          <Button size="sm" variant="secondary" icon={<Plus size={13} />} disabled={!adding.trim()} onClick={addModel}>
            Add
          </Button>
        </div>
        {suggestions.length > 0 && !adding.trim() && (
          <p className="text-[11px] text-text-subtle">
            Suggestions: {suggestions.slice(0, 6).join(", ")}
            {suggestions.length > 6 ? ` +${suggestions.length - 6} more` : ""}
          </p>
        )}
      </div>

      <Modal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${combo.name}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                remove.mutate(combo.id, {
                  onSuccess: () => {
                    toast("Combo deleted");
                    setConfirmDelete(false);
                  },
                  onError: (err) => toastApiError(toast, err, "Delete failed"),
                })
              }
            >
              Delete Combo
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Clients still sending <span className="font-mono text-text-main">{combo.name}</span> as the model lose this route.
        </p>
      </Modal>
    </Card>
  );
}

function NewComboModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateCombo();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && /^[a-zA-Z0-9_.-]+$/.test(trimmed);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New Combo"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabled={!valid}
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                { name: trimmed, models: [], strategy: "fallback" },
                {
                  onSuccess: () => {
                    toast("Combo created");
                    setName("");
                    onClose();
                  },
                  onError: (err) => toastApiError(toast, err, "Create failed"),
                },
              )
            }
          >
            Create Combo
          </Button>
        </>
      }
    >
      <Input
        label="Name"
        mono
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="dev-combo"
        hint="Letters, digits, dot, dash, underscore — clients set model to this name (never name/model)"
        error={trimmed.length > 0 && !valid ? "Invalid characters in name" : undefined}
      />
    </Modal>
  );
}

function AliasesPanel({ suggestions }: { suggestions: string[] }) {
  const toast = useToast();
  const aliases = useAliases();
  const setAlias = useSetAlias();
  const deleteAlias = useDeleteAlias();
  const [form, setForm] = useState({ alias: "", target: "" });

  const save = () => {
    const alias = form.alias.trim();
    const target = form.target.trim();
    if (!alias || !target) return;
    setAlias.mutate({ alias, target }, {
      onSuccess: () => {
        toast("Alias saved");
        setForm({ alias: "", target: "" });
      },
      onError: (err) => toastApiError(toast, err, "Failed to save alias"),
    });
  };

  const entries = Object.entries(aliases.data ?? {});

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Aliases</h3>
          <p className="text-[11px] text-text-subtle">Stable client-facing names mapped to a concrete model</p>
        </div>
        <Badge variant="default" size="sm">
          {entries.length}
        </Badge>
      </div>

      {aliases.isLoading ? (
        <Skeleton rows={2} />
      ) : entries.length === 0 ? (
        <p className="rounded-[8px] border border-dashed border-border px-3 py-4 text-center text-xs text-text-subtle">
          No aliases yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map(([alias, target]) => (
            <div
              key={alias}
              className="flex items-center gap-2 rounded-[8px] border border-border-subtle bg-surface-2 px-2.5 py-1.5"
            >
              <span className="font-mono text-xs font-semibold text-text-main">{alias}</span>
              <span className="text-text-subtle">→</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">{target}</span>
              <button
                aria-label={`Delete alias ${alias}`}
                onClick={() =>
                  deleteAlias.mutate(alias, {
                    onSuccess: () => toast("Alias deleted"),
                    onError: (err) => toastApiError(toast, err, "Delete failed"),
                  })
                }
                className="rounded-[6px] p-1 text-text-subtle transition-colors hover:text-danger"
              >
                <Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 border-t border-border-subtle pt-3">
        <Input
          label="Alias"
          mono
          value={form.alias}
          onChange={(e) => setForm({ ...form, alias: e.target.value })}
          placeholder="smart"
          className="flex-1"
          inputClassName="h-8 py-0 text-xs"
        />
        <Input
          label="Target"
          mono
          list="routable-models"
          value={form.target}
          onChange={(e) => setForm({ ...form, target: e.target.value })}
          placeholder={suggestions[0] ?? "demo/test-model"}
          className="flex-1"
          inputClassName="h-8 py-0 text-xs"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!form.alias.trim() || !form.target.trim()}
          loading={setAlias.isPending}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

function suggestionBanner(state: ModelsState): { tone: "muted" | "warning"; text: string } {
  if (state.status === "loading") return { tone: "muted", text: "loading routable model names…" };
  if (state.status === "unreachable")
    return { tone: "warning", text: `model list unavailable (${state.reason}) — names can still be typed by hand` };
  if (state.models.length === 0)
    return { tone: "muted", text: "nothing routable yet — add an upstream, alias or combo first" };
  return { tone: "muted", text: `${state.models.length} routable model names offered as suggestions` };
}

export function Combos() {
  const combos = useCombos();
  const [newOpen, setNewOpen] = useState(false);
  const modelsState = useRoutableModels();
  const suggestions = modelsState.status === "reachable" ? modelsState.models : [];
  const banner = suggestionBanner(modelsState);

  const datalist = useMemo(
    () => (
      <datalist id="routable-models">
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    ),
    [suggestions],
  );

  return (
    <div className="flex flex-col gap-5">
      {datalist}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={cn("text-xs", banner.tone === "warning" ? "text-warning" : "text-text-muted")}>{banner.text}</span>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setNewOpen(true)}>
          New Combo
        </Button>
      </div>

      {combos.isLoading ? (
        <Skeleton rows={6} />
      ) : (combos.data?.length ?? 0) === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-16 text-center">
          <Stack size={40} className="text-text-subtle" />
          <p className="text-sm text-text-muted">No combos yet. A combo routes one name to an ordered set of models.</p>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setNewOpen(true)}>
            New Combo
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 sm:gap-4">
          {combos.data?.map((c) => (
            <ComboCard key={c.id} combo={c} suggestions={suggestions} />
          ))}
        </div>
      )}

      <AliasesPanel suggestions={suggestions} />
      <NewComboModal isOpen={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
