import { useParams, Link, Navigate } from "react-router-dom";
import { useMediaCatalog, useNodes } from "../api/hooks";
import { MediaProviderSettings } from "../components/MediaProviderSettings";
import { MEDIA_KIND_INFO, type ResolvedNodeMedia } from "../api/types";
import { KeysTab, ModelsTab } from "./ProviderDetail";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * One media provider, with its keys.
 *
 * The reason this screen exists instead of a new key editor: adding an account here is the SAME
 * component the text-generation provider page uses (`KeysTab`, exported from ProviderDetail), so
 * multiple keys, priority, per-key status and test behave identically by construction rather than
 * by keeping two implementations in step. What is media-specific is the header: which endpoints
 * this provider answers, where to get a key, and what the provider itself says about the cost.
 *
 * Under the hood a media provider is a node — that is what gives it keys, rotation, breakers and
 * model rows for free — so the advanced knobs (endpoint, credential style, mapping) stay one link
 * away on the provider's own page instead of being reimplemented here.
 */
export function MediaProvider() {
  const { id } = useParams<{ id: string }>();
  const nodes = useNodes();
  const catalog = useMediaCatalog();

  const node = nodes.data?.find((n) => n.id === id);
  // A node just created here lands in this list via a refetch — reading the list before that
  // refetch settles used to bounce the new provider straight back to /media (the card says
  // "added", the URL says otherwise). Wait for the fetch instead of redirecting on stale data;
  // only a settled list without the id is a real "not found".
  if (nodes.isLoading || (nodes.isFetching && !node)) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!node) return <Navigate to="/media" replace />;

  const media = (node.media ?? { kinds: [], urls: {}, auth: {}, noAuth: false }) as ResolvedNodeMedia;
  const kinds = media.kinds ?? [];
  const entry = (catalog.data?.kinds && Object.values(catalog.data.kinds).flat().find((p) => p.id === media.provider)) ?? null;
  const keyUrl = entry?.keyUrl ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/media" className="text-xs text-text-muted hover:text-accent">
            ← Media
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold text-text-main">{node.name}</h1>
            <span className="font-mono text-[11px] text-text-muted">{node.prefix}</span>
            <Badge variant={node.status === "healthy" ? "success" : node.status === "down" ? "error" : node.status === "degraded" ? "warning" : "default"} size="sm">
              {node.status}
            </Badge>
            {media.noAuth === true && <Badge variant="default" size="sm">no auth</Badge>}
          </div>
          {entry?.notice && <p className="mt-1 max-w-2xl text-[11px] text-text-muted">{entry.notice}</p>}
        </div>
        <div className="flex items-center gap-2">
          {keyUrl && (
            <a href={keyUrl} target="_blank" rel="noreferrer">
              <Button size="sm" variant="outline">Get a key</Button>
            </a>
          )}
        </div>
      </div>

      <Card padding="sm" className="flex flex-col gap-2">
        <div className="text-sm font-semibold text-text-main">Endpoints</div>
        {kinds.length === 0 ? (
          <div className="text-[11px] text-text-muted">No media kind declared — this node serves chat only.</div>
        ) : (
          kinds.map((kind) => {
            const info = MEDIA_KIND_INFO.find((k) => k.id === kind);
            const url = media.urls?.[kind] ?? null;
            const style = media.auth?.[kind] ?? "bearer";
            return (
              <div key={kind} className="font-mono text-[11px] text-text-muted">
                {info?.method} {info?.path} → {url ?? `${node.baseUrl} (${info?.path} appended)`} · {style}
              </div>
            );
          })
        )}
        {Object.keys(media.map ?? {}).length > 0 && (
          <div className="text-[11px] text-text-muted">
            request mapping configured for {Object.keys(media.map ?? {}).join(", ")}
          </div>
        )}
      </Card>

      {/* Endpoint, credential style and the "no key" switch — the media provider's own advanced
          settings, which never route out of this menu. */}
      <MediaProviderSettings node={node} />

      {/* The same key UI a text-generation provider gets — multiple keys, priority, per-key test. */}
      <KeysTab node={node} />

      {kinds.some((k) => MEDIA_KIND_INFO.find((i) => i.id === k)?.modelList === "node") && (
        <>
          <div className="text-sm font-semibold text-text-main">Models</div>
          <ModelsTab node={node} />
        </>
      )}
    </div>
  );
}
