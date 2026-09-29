import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  useAddModel,
  useAddNode,
  useNodes,
  useProviderCatalog,
  useRemoveNode,
  useTestAllKeys,
  useUpdateNode,
} from "../api/hooks";
import type { ProviderPreset, NodeStatus, UpstreamNode } from "../api/types";
import { toastApiError } from "../utils/errors";
import { fmtMs } from "../utils/format";
import { Broadcast, CaretRight, Check, CheckCircle, Plus, Prohibit, WifiHigh, XCircle } from "../components/icons";
import { NodeFormModal } from "../components/NodeFormModal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Tabs } from "../components/ui/Tabs";
import { useToast } from "../components/ui/Toast";

const statusMeta: Record<
  NodeStatus,
  { badge: "success" | "warning" | "error" | "default"; label: string; dot: "green" | "yellow" | "red" | "gray" }
> = {
  healthy: { badge: "success", label: "healthy", dot: "green" },
  degraded: { badge: "warning", label: "degraded", dot: "yellow" },
  down: { badge: "error", label: "breaker open", dot: "red" },
  disabled: { badge: "default", label: "disabled", dot: "gray" },
};

const filterTabs = [
  { value: "all", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "degraded", label: "Degraded" },
  { value: "down", label: "Down" },
  { value: "disabled", label: "Disabled" },
];

/**
 * A card is for scanning and navigating; the detail page is for doing. The mutating actions
 * (Test keys, Enable/Disable, Remove) stay on the card — there is room now, unlike a table row.
 */
function NodeCard({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const navigate = useNavigate();
  const testAll = useTestAllKeys();
  const updateNode = useUpdateNode();
  const removeNode = useRemoveNode();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const meta = statusMeta[node.status];
  const disabled = node.status === "disabled";

  const open = () => navigate(`/upstreams/${node.id}`);

  return (
    <div
      onClick={open}
      className="flex cursor-pointer flex-col gap-1.5 rounded border border-border-subtle p-3 transition-colors hover:bg-surface-2/60"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={meta.dot} />
          <Link
            to={`/upstreams/${node.id}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate text-sm font-medium text-text-main hover:text-primary hover:underline"
          >
            {node.name}
          </Link>
        </div>
        <Badge variant={meta.badge} size="sm" dot>
          {meta.label}
        </Badge>
      </div>
      <p className="truncate font-mono text-[11px] text-text-muted" title={node.baseUrl}>
        {node.baseUrl}
      </p>
      <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-text-subtle">
        <span className="font-mono">{node.prefix || "—"}</span>
        <span>·</span>
        <span title={node.modelCount === 0 ? "Open the provider to import or add models" : undefined}>
          {node.modelCount} model{node.modelCount === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>{fmtMs(node.latencyMs)}</span>
        <span>·</span>
        <span className="font-mono">{node.keyMasked}</span>
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-end gap-1 pt-1" onClick={(e) => e.stopPropagation()}>
        <Button
          size="sm"
          variant="secondary"
          icon={<WifiHigh size={13} />}
          loading={testAll.isPending}
          onClick={() =>
            testAll.mutate(
              { nodeId: node.id },
              {
                onSuccess: (r) => toast(`${r.ok}/${r.tested} keys ok`, r.ok === r.tested ? "success" : "error"),
                onError: (err) => toastApiError(toast, err, "Key test failed"),
              },
            )
          }
        >
          Test keys
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={disabled ? `Enable ${node.name}` : `Disable ${node.name}`}
          icon={disabled ? <Check size={13} /> : <Prohibit size={13} />}
          disabled={updateNode.isPending}
          onClick={() =>
            updateNode.mutate(
              { id: node.id, patch: { enabled: disabled } },
              {
                onSuccess: () => toast(disabled ? "Provider enabled" : "Provider disabled"),
                onError: (err) => toastApiError(toast, err, disabled ? "Failed to enable" : "Failed to disable"),
              },
            )
          }
        >
          {disabled ? "Enable" : "Disable"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${node.name}`}
          className="hover:bg-danger/10 hover:text-danger"
          icon={<XCircle size={14} />}
          onClick={() => setConfirmRemove(true)}
        />
        <Button size="sm" variant="ghost" icon={<CaretRight size={13} />} aria-label={`Manage ${node.name}`} onClick={open} />
      </div>

      <Modal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${node.name}?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                removeNode.mutate(node.id, {
                  onSuccess: () => {
                    toast("Provider removed");
                    setConfirmRemove(false);
                  },
                  onError: (err) => toastApiError(toast, err, "Remove failed"),
                })
              }
            >
              Remove Provider
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Removes the provider, its API keys and its model list. Requests routing to
          <span className="font-mono"> {node.prefix}/…</span> will stop resolving.
        </p>
      </Modal>
    </div>
  );
}

/**
 * One preset card — catalogue inventory, deliberately its own thing: what 9Router ships and
 * routy can add, grouped by registry category (never a live node; those are the cards under
 * "Your providers"). Once added, the card flips to "added" and links to the node's page for
 * keys, models and probing.
 */
function PresetCard({ entry, node, onAdd }: { entry: ProviderPreset; node?: UpstreamNode; onAdd: () => void }) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded border border-border-subtle p-3 ${entry.supported ? "" : "opacity-60"}`}
      title={entry.supported ? undefined : entry.why ?? undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-text-main">{entry.name}</span>
        {node ? (
          <Badge variant="success" size="sm">added</Badge>
        ) : entry.supported ? (
          <Badge variant="default" size="sm">free</Badge>
        ) : (
          <Badge variant="default" size="sm">not yet</Badge>
        )}
      </div>
      <p className="truncate font-mono text-[11px] text-text-muted" title={entry.baseUrl ?? entry.why ?? undefined}>
        {entry.baseUrl ?? entry.why}
      </p>
      <p className="text-[11px] text-text-subtle">
        {entry.supported
          ? `${entry.models.length} model${entry.models.length === 1 ? "" : "s"} · ${entry.format}`
          : entry.why}
      </p>
      {entry.requires.length > 0 && <p className="text-[11px] text-text-muted">{entry.requires.join("; ")}</p>}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        {entry.keyUrl ? (
          <a href={entry.keyUrl} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline">
            Get a key
          </a>
        ) : (
          <span />
        )}
        {node ? (
          <Link to={`/upstreams/${node.id}`} className="text-[11px] text-accent hover:underline">
            Open
          </Link>
        ) : entry.supported ? (
          <Button variant="secondary" size="sm" onClick={onAdd}>
            Add
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** What each registry category is called on screen, in 9Router's own terms. */
const CATEGORY_INFO: Record<string, { title: string; blurb: string }> = {
  freeTier: {
    title: "Free tier",
    blurb:
      "Chat providers 9Router ships under its free tier, added straight from the catalogue — endpoint and models come with the preset; the key goes on the provider's page next. Entries marked \"not yet\" name the transport routy does not speak yet.",
  },
  free: {
    title: "Free (no auth)",
    blurb:
      "The registry's no-credential five — these send without any key at all. Only the ones routy can actually reach carry an Add.",
  },
};

/** One category's card group: heading, honest blurb, added-count badge, grid. */
function PresetSection({
  title,
  blurb,
  entries,
  nodeFor,
  onAdd,
  loading,
}: {
  title: string;
  blurb: string;
  entries: ProviderPreset[];
  nodeFor: (entry: ProviderPreset) => UpstreamNode | undefined;
  onAdd: (entry: ProviderPreset) => void;
  loading: boolean;
}) {
  if (entries.length === 0 && !loading) return null;
  const added = entries.filter((e) => nodeFor(e)).length;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-main">{title}</h2>
          <p className="text-xs text-text-muted">{blurb}</p>
        </div>
        <Badge variant="default" size="sm">
          {added} of {entries.length} added
        </Badge>
      </div>
      {loading ? (
        <Skeleton rows={4} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {entries.map((entry) => (
            <PresetCard key={entry.id} entry={entry} node={nodeFor(entry)} onAdd={() => onAdd(entry)} />
          ))}
        </div>
      )}
    </section>
  );
}

export function Upstreams() {
  const nodes = useNodes();
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const catalog = useProviderCatalog();
  const addNode = useAddNode();
  const addModel = useAddModel();

  // Catalogue cards group by 9Router's own registry category — one section per category.
  const presets = catalog.data?.providers ?? [];
  const categories = [...new Set(presets.map((p) => p.category))];
  const presetNode = (entry: ProviderPreset) => (nodes.data ?? []).find((n) => n.data?.preset === entry.id);

  /** Add from the preset: endpoint, model rows and the `data.preset` marker that keeps this node
   *  on its card and out of the cards below. No key yet — the node's own page is where keys go. */
  const addPreset = async (entry: ProviderPreset) => {
    if (!entry.supported || !entry.baseUrl) return;
    let prefix = entry.id;
    let n = 2;
    while ((nodes.data ?? []).some((x) => x.prefix === prefix)) prefix = `${entry.id}-${n++}`;
    let created: UpstreamNode;
    try {
      created = await addNode.mutateAsync({ name: entry.name, prefix, baseUrl: entry.baseUrl, apiKey: "", data: { preset: entry.id, ...(entry.data ?? {}) } });
    } catch (err) {
      toastApiError(toast, err, `Failed to add ${entry.name}`);
      return;
    }
    // Model rows are separate writes; a rejected row must not fail an add that already worked —
    // the node routes by <prefix>/<model> regardless, and its Models tab edits rows anyway.
    for (const m of entry.models) {
      try {
        await addModel.mutateAsync({ nodeId: created.id, model: m.id });
      } catch { /* keep going */ }
    }
    toast(entry.category === "free" ? `${entry.name} added — no key needed` : `${entry.name} added — add its key next`);
    navigate(`/upstreams/${created.id}`);
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (nodes.data ?? []).filter((n) => {
      // Media providers are the OTHER thing: they are added from the Media menu and live there,
      // so this screen shows only what the user added by hand for text generation.
      if (n.media?.provider) return false;
      // Free-tier adds live on their catalogue cards, not in this table — two kinds of thing,
      // two lists, exactly like the media providers above.
      if (n.data?.preset) return false;
      if (filter !== "all" && n.status !== filter) return false;
      if (!needle) return true;
      return `${n.name} ${n.baseUrl} ${n.prefix}`.toLowerCase().includes(needle);
    });
  }, [nodes.data, filter, search]);

  if (nodes.isError) {
    const message = nodes.error instanceof Error ? nodes.error.message : "";
    return (
      <Card className="flex flex-col items-center gap-3 py-16 text-center">
        <XCircle size={40} className="text-text-subtle" />
        <p className="text-sm text-text-muted">Gateway unreachable. {message}</p>
        <p className="text-xs text-text-subtle">
          Start it with <code className="font-mono text-text-main">routy serve</code>, then Retry.
        </p>
        <Button variant="secondary" onClick={() => nodes.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  const total = (nodes.data ?? []).filter((n) => !n.media?.provider && !n.data?.preset).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Catalogue cards, deliberately separate from the operator's own below — one mixed
          list would answer neither question. */}
      {categories.map((cat) => (
        <PresetSection
          key={cat}
          title={CATEGORY_INFO[cat]?.title ?? cat}
          blurb={CATEGORY_INFO[cat]?.blurb ?? ""}
          entries={presets.filter((p) => p.category === cat)}
          nodeFor={presetNode}
          onAdd={addPreset}
          loading={catalog.isLoading}
        />
      ))}

      <div className="flex flex-col gap-1 border-t border-border-subtle pt-4">
        <h2 className="text-sm font-semibold text-text-main">Your providers</h2>
        <p className="text-xs text-text-muted">Text-generation providers you added yourself — health, keys and probing live in the table.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onChange={setFilter} items={filterTabs} size="sm" />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, URL, prefix"
            className="w-full min-w-0 sm:w-56"
            inputClassName="h-8 py-0 text-xs"
          />
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
            Add Provider
          </Button>
        </div>
      </div>

      {nodes.isLoading ? (
        <Card padding="sm">
          <Skeleton rows={5} />
        </Card>
      ) : visible.length === 0 ? (
        <Card padding="none">
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <Broadcast size={40} className="text-text-subtle" />
            <p className="text-sm text-text-muted">
              {total === 0 ? "No providers of your own yet — use Add Provider, or pick a preset card above." : "No providers match this filter."}
            </p>
            {total === 0 && (
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
                Add Provider
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((n) => (
            <NodeCard key={n.id} node={n} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 px-1 text-xs text-text-subtle">
        <CheckCircle size={13} className="shrink-0" />
        Status is real breaker state: degraded = failures recorded, down = breaker open, disabled = provider off.
      </div>

      <NodeFormModal
        isOpen={addOpen}
        node={null}
        onClose={() => setAddOpen(false)}
      />
    </div>
  );
}
