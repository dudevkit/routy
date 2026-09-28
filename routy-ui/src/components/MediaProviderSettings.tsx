import { useEffect, useState } from "react";
import { useUpdateNode } from "../api/hooks";
import { MEDIA_KIND_INFO, derivedMediaUrl, type MediaKind, type NodeMediaConfig, type ResolvedNodeMedia, type UpstreamNode } from "../api/types";
import { toastApiError } from "../utils/errors";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { Toggle } from "./ui/Toggle";
import { useToast } from "./ui/Toast";

const AUTH_STYLES = [
  { value: "bearer", label: "Bearer — Authorization: Bearer <key> (the default)" },
  { value: "token", label: "Token — Authorization: Token <key>" },
  { value: "x-api-key", label: "x-api-key header" },
  { value: "key", label: "Key — Authorization: Key <key>" },
  { value: "query", label: "Query parameter — the key travels in the URL, named by the mapping" },
  { value: "none", label: "No credential — a local endpoint that answers without one" },
] as const;

const EMPTY_MEDIA: ResolvedNodeMedia = { kinds: [], urls: {}, auth: {}, noAuth: false };

/**
 * A media provider's own advanced settings, reached only from the Media menu.
 *
 * This is the tuning half of media configuration — endpoint, credential style, "needs no key" —
 * and it deliberately lives HERE rather than on the provider page: a provider is a text-generation
 * concept, so a media provider's settings must never require leaving the Media menu. The write
 * shape is the same rule the rest of this feature follows: `media` is REPLACED wholesale by the
 * server, so every call carries the complete next state, including the mapping and the catalogue
 * link, or the edit would silently erase them.
 */
export function MediaProviderSettings({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const updateNode = useUpdateNode();
  const media: ResolvedNodeMedia = node.media ?? EMPTY_MEDIA;
  const declared = media.kinds ?? [];

  // Drafts for the URL fields: typed freely, pushed on blur. Synced on node change only — a
  // refetch mid-typing would otherwise overwrite the field the user is still in.
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    setUrls(Object.fromEntries(Object.entries(node.media?.urls ?? {}).map(([k, v]) => [k, v ?? ""])));
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = (next: Partial<NodeMediaConfig>, message: string) => {
    const current: NodeMediaConfig = {
      kinds: declared,
      urls: Object.fromEntries(
        Object.entries(media.urls ?? {}).filter(([, v]) => typeof v === "string" && v.length > 0),
      ) as NodeMediaConfig["urls"],
      auth: Object.fromEntries(
        Object.entries((media.auth ?? {}) as Record<string, string>)
          .filter(([, v]) => v && v !== "bearer") // the default is written as absent, not repeated
          .map(([k, v]) => [k, { style: v }]),
      ),
      // Carried through, or editing a URL would erase the mapping and the catalogue link — the
      // server replaces `media`, it does not merge it.
      ...(media.map && Object.keys(media.map).length ? { map: media.map } : {}),
      ...(media.provider ? { provider: media.provider } : {}),
      ...(media.noAuth ? { noAuth: true } : {}),
    };
    const data = { ...current, ...next };
    updateNode.mutate(
      { id: node.id, patch: { data: { ...node.data, media: data } } },
      {
        onSuccess: () => toast(message),
        onError: (err) => toastApiError(toast, err, "Failed to save media settings"),
      },
    );
  };

  const setAuth = (kind: MediaKind, style: string) => {
    const auth = { ...(media.auth as Record<string, string>) };
    if (style === "bearer") delete auth[kind]; // the default, written as absent rather than repeated
    else auth[kind] = style;
    push({ auth: Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, { style: v }])) }, `${kind}: ${style}`);
  };

  const setUrl = (kind: MediaKind, raw: string) => {
    const trimmed = raw.trim();
    const urlsNext = { ...(media.urls as Record<string, string | null>) };
    if (trimmed) urlsNext[kind] = trimmed;
    else delete urlsNext[kind];
    push({ urls: urlsNext }, trimmed ? `${kind} URL saved` : `${kind} URL cleared — using the node's base URL`);
    setUrls((u) => ({ ...u, [kind]: raw }));
  };

  const toggleNoAuth = (on: boolean) => {
    push({ noAuth: on ? true : undefined }, on ? "This provider needs no credentials" : "Credentials required again");
  };

  if (declared.length === 0) return null;

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Advanced settings</h3>
          <p className="text-[11px] text-text-muted">
            Endpoint and credential per kind. Left empty, the URL is the gateway default for that endpoint; every field applies the moment you leave it.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={updateNode.isPending}
          onClick={() => push({}, "Settings unchanged")}
        >
          Re-apply
        </Button>
      </div>

      <div className="flex flex-col gap-4 divide-y divide-border-subtle">
        {declared.map((kind) => {
          const info = MEDIA_KIND_INFO.find((k) => k.id === kind);
          const style = (media.auth as Record<string, string>)[kind] ?? "bearer";
          const effective = (urls[kind] ?? "").trim() || derivedMediaUrl(node.baseUrl, info?.path ?? "");
          return (
            <div key={kind} className="flex flex-col gap-2 pt-3 first:pt-0">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-56 flex-1">
                  <Input
                    label={`${info?.label ?? kind} URL`}
                    value={urls[kind] ?? ""}
                    placeholder={derivedMediaUrl(node.baseUrl, info?.path ?? "")}
                    disabled={updateNode.isPending}
                    onChange={(e) => setUrls((u) => ({ ...u, [kind]: e.target.value }))}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== ((media.urls as Record<string, string | null>)[kind] ?? "")) setUrl(kind, e.target.value);
                    }}
                  />
                </div>
                <div className="min-w-64 flex-1">
                  <Select
                    label="Credential"
                    value={style}
                    options={[...AUTH_STYLES]}
                    disabled={updateNode.isPending}
                    onChange={(e) => setAuth(kind, e.target.value)}
                  />
                </div>
              </div>
              <div className="font-mono text-[11px] text-text-muted">→ {effective}</div>
              {(media.map ?? {})[kind] && (
                <div className="text-[11px] text-text-muted">
                  request mapping configured ({Object.keys((media.map as Record<string, object>)[kind]).join(", ")})
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
        <div className="min-w-0">
          <div className="text-sm text-text-main">No credentials needed</div>
          <p className="text-[11px] text-text-muted">
            For an endpoint that answers without a key — a local SearXNG, a house TTS server. The dashboard shows it as ready rather than missing a connection.
          </p>
        </div>
        <Toggle
          label=""
          hint={media.noAuth === true ? "no key is sent" : "the node's key is sent"}
          checked={media.noAuth === true}
          onChange={(v) => toggleNoAuth(v)}
        />
      </div>
    </Card>
  );
}
