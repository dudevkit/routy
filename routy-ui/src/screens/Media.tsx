import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useModelsForKind, useNodes } from "../api/hooks";
import { MEDIA_KIND_INFO, derivedMediaUrl, type MediaKind } from "../api/types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";
import { Tabs } from "../components/ui/Tabs";

/**
 * Media: the six non-chat kinds routy serves, one tab each.
 *
 * What the screen is FOR is answering the question a gateway client actually asks — "which of
 * these does this gateway serve, under which ids, and through which provider" — so each tab
 * shows the endpoint, the providers that declare the kind, and the ids that come out of it.
 * A kind a node has not declared is not a candidate for it, which is why the provider list here
 * is filtered rather than merely highlighted.
 *
 * Declaring a kind happens on the provider's own Media tab (the tab was added with this screen)
 * — this is the read surface, and it says so in its empty state instead of leaving the user
 * guessing where the button went.
 */
export function Media() {
  const [kind, setKind] = useState<MediaKind>("embedding");
  const nodes = useNodes();
  const models = useModelsForKind(kind);

  const info = MEDIA_KIND_INFO.find((k) => k.id === kind) ?? MEDIA_KIND_INFO[0];
  const serving = useMemo(() => (nodes.data ?? []).filter((n) => (n.mediaKinds ?? []).includes(kind)), [nodes.data, kind]);
  const entries = models.data?.data ?? [];

  // Group ids by the node that carries them, in node order — the same order the cards above use,
  // so a reader can match them without counting rows.
  const byNode = useMemo(() => {
    const groups = new Map<string, { id: string; ownedBy?: string }[]>();
    for (const e of entries) {
      const owner = e.owned_by ?? "";
      const key = owner.startsWith("routy-node:") ? owner.slice("routy-node:".length) : owner;
      const list = groups.get(key) ?? [];
      list.push({ id: e.id, ownedBy: e.owned_by });
      groups.set(key, list);
    }
    return groups;
  }, [entries]);

  const noModelList = info.modelList !== "node";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">Media</h1>
        <p className="mt-1 text-sm text-text-muted">
          The gateway serves each kind on its own endpoint. A provider reaches an endpoint only after the kind is declared on its Media tab — chat stays always-on and is not listed here.
        </p>
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
        <Badge variant="default" size="sm">
          {serving.length} provider{serving.length === 1 ? "" : "s"}
        </Badge>
      </Card>

      {serving.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded border border-dashed border-border-subtle px-6 py-12 text-center">
          <p className="text-sm text-text-main">No provider declares {info.label} yet.</p>
          <p className="max-w-xl text-[11px] text-text-muted">
            Open a provider, then its Media tab, and turn the kind on. The endpoint starts accepting
            requests against that provider as soon as it is declared — nothing else is required.
          </p>
          <Link to="/upstreams">
            <Button size="sm" variant="outline">
              Open providers
            </Button>
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {serving.map((node) => {
            const ids = byNode.get(node.prefix) ?? [];
            return (
              <Card key={node.id} padding="sm" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Link to={`/upstreams/${node.id}`} className="truncate text-sm font-medium text-text-main hover:text-accent">
                      {node.name}
                    </Link>
                    <span className="font-mono text-[11px] text-text-muted">{node.prefix}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={node.status === "healthy" ? "success" : node.status === "down" ? "error" : node.status === "degraded" ? "warning" : "default"} size="sm">
                      {node.status}
                    </Badge>
                    {(node.media?.noAuth ?? false) && (
                      <Badge variant="default" size="sm">
                        no auth
                      </Badge>
                    )}
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
                        to={`/upstreams/${node.id}`}
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
