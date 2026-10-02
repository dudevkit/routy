import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAddNode, useMediaCatalog, useModelsForKind, useNodes } from "../api/hooks";
import { MEDIA_KIND_INFO, derivedMediaUrl, type MediaCatalogEntry, type MediaKind } from "../api/types";
import { toastApiError } from "../utils/errors";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";
import { Tabs } from "../components/ui/Tabs";
import { useToast } from "../components/ui/Toast";

/**
 * Media: one tab per kind, and inside each tab EVERY provider 9Router ships for it.
 *
 * The screen is where media providers live, deliberately separate from the text-generation
 * providers: a code agent connects to those, while these are the accounts behind `/v1/search`,
 * `/v1/embeddings` and friends. Two consequences the layout encodes:
 *
 *   · The list is the CATALOGUE, not the configured subset. An unconfigured provider is the normal
 *     state, not an empty state — a card says "key needed", not "nothing here yet".
 *   · Adding one writes endpoint + credential style + request mapping from the catalogue (there is
 *     nothing to type), and the keys go on the provider's own page through the same component a
 *     text-generation provider uses. One key editor, two menus.
 *
 * Nodes created from a preset carry `media.provider`, which is how a card finds its node — and
 * why they are excluded from the "also serving" list below rather than appearing twice.
 */
export function Media() {
  const [kind, setKind] = useState<MediaKind>("embedding");
  const toast = useToast();
  const navigate = useNavigate();
  const nodes = useNodes();
  const models = useModelsForKind(kind);
  const catalog = useMediaCatalog();
  const addNode = useAddNode();

  const info = MEDIA_KIND_INFO.find((k) => k.id === kind) ?? MEDIA_KIND_INFO[0];
  const entries = catalog.data?.kinds?.[kind] ?? [];
  // Nodes serving this kind that were configured by hand (no catalogue entry behind them).
  const serving = useMemo(
    () => (nodes.data ?? []).filter((n) => (n.mediaKinds ?? []).includes(kind) && !n.media?.provider),
    [nodes.data, kind],
  );
  const nodeFor = (entry: MediaCatalogEntry) =>
    nodes.data?.find((n) => n.media?.provider === entry.id && (n.mediaKinds ?? []).includes(kind)) ?? null;
  const configured = entries.filter((entry) => nodeFor(entry)).length;

  const entriesByKind = models.data?.data ?? [];

  // Group ids by the node that carries them, in node order — the same order the cards below use,
  // so a reader can match them without counting rows.
  const byNode = useMemo(() => {
    const groups = new Map<string, { id: string; ownedBy?: string }[]>();
    for (const e of entriesByKind) {
      const owner = e.owned_by ?? "";
      const key = owner.startsWith("routy-node:") ? owner.slice("routy-node:".length) : owner;
      const list = groups.get(key) ?? [];
      list.push({ id: e.id, ownedBy: e.owned_by });
      groups.set(key, list);
    }
    return groups;
  }, [entriesByKind]);

  const noModelList = info.modelList !== "node";

  /** Create the provider's node straight from the preset: kinds, endpoint, credential style and
   *  mapping all come from the catalogue. No key yet — 9Router's own cards say "No connections"
   *  too, and the next screen is where keys are added. */
  const addProvider = async (entry: MediaCatalogEntry) => {
    const preset = entry.preset?.media;
    if (!preset) return;
    let prefix = entry.id;
    let n = 2;
    while (nodes.data?.some((x) => x.prefix === prefix)) prefix = `${entry.id}-${n++}`;
    let baseUrl = "http://127.0.0.1:9";
    try { baseUrl = new URL(preset.urls?.[kind] ?? "").origin; } catch { /* keep the stub */ }
    // await the mutation rather than wiring a per-call onSuccess: the callback form created the
    // provider and then never navigated (verified in a browser), while this path either lands on
    // the new provider's page or reports why it did not — no silent middle state.
    try {
      const created = await addNode.mutateAsync({ name: entry.name, prefix, baseUrl, apiKey: "", data: { media: preset } });
      toast(`${entry.name} added — add its key next`);
      navigate(`/media/${created.id}`);
    } catch (err) {
      toastApiError(toast, err, `Failed to add ${entry.name}`);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="text-sm text-text-muted">
        Every media provider the gateway can reach, grouped by the endpoint it answers. Adding one here
        configures it; keys are added on its own page, exactly like a provider&apos;s. Chat providers
        stay on <Link to="/upstreams" className="text-primary hover:underline">Providers</Link>.
      </div>

      <Tabs
        value={kind}
        onChange={(v) => setKind(v as MediaKind)}
        items={MEDIA_KIND_INFO.map((k) => ({ value: k.id, label: k.label }))}
      />

      <Card padding="sm" className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-text-main">
            {info.method} {info.path}
          </div>
          <div className="mt-1 text-[11px] text-text-muted">
            {info.modelList === "node" && "Models for this kind are rows on the provider — ids look like prefix/model."}
            {info.modelList === "none" && "The provider IS the model: send the prefix itself, and every entry below is one routable target."}
            {info.modelList === "voices" && "The model field names a voice on the provider. Routy does not enumerate voices yet — add a voice id as a model row."}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="default" size="sm">{configured} of {entries.length} added</Badge>
          <Badge variant="default" size="sm">
            {serving.length} custom provider{serving.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </Card>

      {entries.length === 0 ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => {
            const node = nodeFor(entry);
            const usable = Boolean(node) || Boolean(entry.supported && entry.preset);
            return (
              <div
                key={entry.id}
                className={`flex flex-col gap-1.5 rounded border border-border-subtle p-3 ${usable ? "" : "opacity-60"}`}
                title={!usable ? entry.why ?? undefined : undefined}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-text-main">{entry.name}</div>
                    <div className="truncate font-mono text-[11px] text-text-muted">
                      {entry.preset?.media.urls?.[kind] ?? entry.id}
                    </div>
                  </div>
                  {node ? (
                    <Badge variant="success" size="sm">added</Badge>
                  ) : usable ? (
                    <Badge variant={entry.free ? "success" : "default"} size="sm">
                      {entry.free ? "free tier" : entry.keyUrl ? "key needed" : "ready"}
                    </Badge>
                  ) : (
                    <Badge variant="warning" size="sm">not yet</Badge>
                  )}
                </div>

                {entry.notice && (
                  <div className="line-clamp-2 text-[11px] text-text-muted">{entry.notice}</div>
                )}
                {!usable && entry.why && (
                  <div className="line-clamp-2 text-[11px] text-text-muted">{entry.why}</div>
                )}

                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  {node ? (
                    <Link to={`/media/${node.id}`}>
                      <Button size="sm" variant="outline">Open · add keys</Button>
                    </Link>
                  ) : usable ? (
                    <Button size="sm" disabled={addNode.isPending} onClick={() => addProvider(entry)}>
                      Add
                    </Button>
                  ) : (
                    <span className="text-[11px] text-text-muted">unsupported for now</span>
                  )}
                  {node && entry.keyUrl && (
                    <a href={entry.keyUrl} target="_blank" rel="noreferrer" className="text-[11px] text-text-muted hover:text-accent">
                      get a key →
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {serving.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="text-sm font-semibold text-text-main">Also serving {info.label}</div>
          {serving.map((node) => {
            const ids = byNode.get(node.prefix) ?? [];
            return (
              <Card key={node.id} padding="sm" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Link to={`/media/${node.id}`} className="truncate text-sm font-medium text-text-main hover:text-accent">
                      {node.name}
                    </Link>
                    <span className="font-mono text-[11px] text-text-muted">{node.prefix}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={node.status === "healthy" ? "success" : node.status === "down" ? "error" : node.status === "degraded" ? "warning" : "default"} size="sm">
                      {node.status}
                    </Badge>
                    {(node.media?.noAuth ?? false) && <Badge variant="default" size="sm">no auth</Badge>}
                  </div>
                </div>

                <div className="font-mono text-[11px] text-text-muted">
                  {node.media?.urls?.[kind] ? `→ ${node.media.urls[kind]}` : `→ ${derivedMediaUrl(node.baseUrl, info.path)}`}
                  {"  ·  "}
                  {(node.media?.auth?.[kind] as string | undefined) ?? "bearer"}
                </div>

                {models.isLoading ? (
                  <Skeleton className="h-4 w-40" />
                ) : ids.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {ids.map((e) => (
                      <Link
                        key={e.id}
                        to={`/media/${node.id}`}
                        className="rounded border border-border-subtle px-2 py-0.5 font-mono text-[11px] text-text-main hover:border-accent"
                      >
                        {e.id}
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-text-muted">
                    {noModelList ? (
                      <>nothing to enumerate — the routable id is <span className="font-mono">{node.prefix}</span></>
                    ) : (
                      <>
                        no {info.label.toLowerCase()} model rows yet — add one on this provider&apos;s Models tab
                      </>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
