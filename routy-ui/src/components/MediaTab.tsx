import { useEffect, useState } from "react";
import { useMediaCatalog, useUpdateNode } from "../api/hooks";
import { MEDIA_KIND_INFO, derivedMediaUrl, type MediaCatalogEntry, type MediaKind, type NodeMediaConfig, type ResolvedNodeMedia, type UpstreamNode } from "../api/types";
import { toastApiError } from "../utils/errors";
import { Badge } from "./ui/Badge";
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
 * The Media tab: which non-chat kinds this provider serves, and how each is reached.
 *
 * Every control writes through. That is a deliberate requirement rather than a preference: a
 * toggle that looks applied but was never saved is the defect this whole media feature was
 * pulled from — the combo editor's strategy sat in local state behind a Save button for a
 * release, and the app then obeyed the stored value perfectly while the screen said otherwise.
 *
 * The write shape differs from the read shape in two ways the server demands:
 *   · auth comes back as a style STRING (`"x-api-key"`) and goes back as `{ style: "x-api-key" }`;
 *   · `media` is REPLACED wholesale (that is how a kind is removed), so the payload always
 *     carries the complete next state — and other node settings are spread alongside it so a
 *     media edit cannot quietly drop pricing or a proxy binding.
 */
export function MediaTab({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const updateNode = useUpdateNode();
  const catalog = useMediaCatalog();
  const media: ResolvedNodeMedia = node.media ?? EMPTY_MEDIA;
  const declared = media.kinds ?? [];

  // Drafts for the URL fields: typed freely, pushed on blur. Synced on node change only — a
  // refetch mid-typing would otherwise overwrite the field the user is still in.
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    setUrls(Object.fromEntries(Object.entries(node.media?.urls ?? {}).map(([k, v]) => [k, v ?? ""])));
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The complete next media config, because the server REPLACES the key: a partial payload
   *  would silently drop the kinds or URLs it did not mention — the exact failure a merge rule
   *  exists to prevent on one side and cause on the other. Other node settings are spread
   *  alongside, so a media edit cannot quietly drop pricing or a proxy binding. */
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
      // The mappings belong to this object too, and the server replaces the whole key: leaving
      // them out is how editing a URL used to erase a web provider's mapping.
      ...(media.map && Object.keys(media.map).length ? { map: media.map } : {}),
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

  const toggleKind = (kind: MediaKind, on: boolean) => {
    const kinds = on ? [...declared, kind] : declared.filter((k) => k !== kind);
    push({ kinds }, on ? `${kind} declared on ${node.prefix}` : `${kind} no longer served by ${node.prefix}`);
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
    // keep the draft as typed (the trimmed value only differs by whitespace)
    setUrls((u) => ({ ...u, [kind]: raw }));
  };

  const toggleNoAuth = (on: boolean) => {
    // `undefined` is dropped by JSON.stringify, which is how a key with a default gets removed
    // rather than sent as false — the validator only sees a key that is present.
    push({ noAuth: on ? true : undefined }, on ? "This provider needs no credentials" : "Credentials required again");
  };

  /** The catalogue for one kind, split the way this screen needs it: what can be applied now, and
   *  what cannot — named with the reason, so a 9Router provider missing from the picker is never
   *  a mystery. */
  const catalogFor = (kind: MediaKind): { supported: MediaCatalogEntry[]; unsupported: MediaCatalogEntry[] } => {
    const entries = catalog.data?.kinds?.[kind] ?? [];
    return { supported: entries.filter((e) => e.supported), unsupported: entries.filter((e) => !e.supported) };
  };

  /** Applying a preset is the same write a user makes by hand — endpoint, auth style, and for the
   *  web kinds the mapping — sent whole, because the server replaces `media` rather than merging
   *  it. The presets come from the gateway, so the dashboard never has to know a provider's shape. */
  const applyPreset = (kind: MediaKind, id: string) => {
    const entry = catalogFor(kind).supported.find((e) => e.id === id);
    if (!entry?.preset) return;
    const preset = entry.preset.media;
    const urlsNext = { ...(media.urls as Record<string, string | null>), ...(preset.urls ?? {}) };
    const styles = { ...(media.auth as Record<string, string>) };
    for (const [k, spec] of Object.entries(preset.auth ?? {})) if (spec?.style) styles[k] = spec.style;
    push(
      {
        urls: urlsNext,
        auth: Object.fromEntries(Object.entries(styles).map(([k, v]) => [k, { style: v }])),
        map: { ...(media.map ?? {}), ...(preset.map ?? {}) },
      },
      [
        `${entry.name} preset applied to ${kind}`,
        entry.models.length ? `add its models on the Models tab: ${entry.models.slice(0, 3).join(", ")}${entry.models.length > 3 ? ", …" : ""}` : null,
        ...entry.requires,
      ].filter(Boolean).join(" — "),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Card padding="sm" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text-main">Kinds this provider serves</h3>
            <p className="text-[11px] text-text-muted">
              A request only reaches this node when it declares the kind its endpoint serves. Chat is always available and is not listed.
            </p>
          </div>
          <Badge variant={declared.length ? "primary" : "default"} size="sm">
            {declared.length ? `${declared.length} declared` : "chat only"}
          </Badge>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MEDIA_KIND_INFO.map((k) => (
            <div key={k.id} className="flex items-start justify-between gap-3 rounded border border-border-subtle p-3">
              <div className="min-w-0">
                <div className="text-sm text-text-main">{k.label}</div>
                <div className="font-mono text-[11px] text-text-muted">
                  {k.method} {k.path}
                </div>
                {k.modelList !== "node" && (
                  <div className="mt-1 text-[11px] text-text-muted">
                    {k.modelList === "none" ? "the provider is the model — no model list" : "the model field names a voice"}
                  </div>
                )}
              </div>
              <Toggle
                label=""
                checked={declared.includes(k.id)}
                hint={declared.includes(k.id) ? `serving ${k.label}` : "not served"}
                onChange={(v) => toggleKind(k.id, v)}
              />
            </div>
          ))}
        </div>
      </Card>

      {declared.length > 0 && (
        <Card padding="sm" className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text-main">How each kind is reached</h3>
            <p className="text-[11px] text-text-muted">
              Left empty, the node&apos;s base URL plus the kind&apos;s path is used — the same rule the gateway applies when dispatching.
            </p>
          </div>

          <div className="flex flex-col gap-4 divide-y divide-border-subtle">
            {declared.map((kind) => {
              const info = MEDIA_KIND_INFO.find((k) => k.id === kind);
              const style = (media.auth as Record<string, string>)[kind] ?? "bearer";
              const effective = (urls[kind] ?? "").trim() || derivedMediaUrl(node.baseUrl, info?.path ?? "");
              const { supported, unsupported } = catalogFor(kind);
              return (
                <div key={kind} className="flex flex-col gap-2 pt-3 first:pt-0">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-56 flex-1">
                      {/* Compare against what the SERVER holds, not the draft: onChange keeps the
                          draft equal to the field, so a draft comparison is always false and the
                          blur would save nothing — a field that looks edited but never applies. */}
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
                    <div className="min-w-56 flex-1">
                      {/* A preset is a starting point, not a mode: it writes the endpoint, the
                          auth style and the mapping, and every field stays editable afterwards. */}
                      <Select
                        label="Start from a provider"
                        value=""
                        options={[
                          { value: "", label: supported.length ? `${supported.length} provider${supported.length === 1 ? "" : "s"} available…` : "none for this kind yet" },
                          ...supported.map((e) => ({ value: e.id, label: e.name })),
                        ]}
                        disabled={updateNode.isPending || supported.length === 0}
                        onChange={(e) => {
                          if (e.target.value) applyPreset(kind, e.target.value);
                        }}
                      />
                    </div>
                  </div>
                  <div className="font-mono text-[11px] text-text-muted">→ {effective}</div>
                  {unsupported.length > 0 && (
                    <div className="text-[11px] text-text-muted" title={unsupported.map((e) => `${e.name}: ${e.why}`).join("\n")}>
                      9Router providers not supported yet: {unsupported.slice(0, 4).map((e) => e.name).join(", ")}
                      {unsupported.length > 4 ? ` +${unsupported.length - 4} more` : ""} — hover for the reason
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card padding="sm" className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-text-main">No credentials needed</div>
          <p className="text-[11px] text-text-muted">
            For an endpoint that answers without a key — a local ComfyUI, a house TTS server. The dashboard shows it as ready rather than missing a connection.
          </p>
        </div>
        <Toggle
          label=""
          hint={media.noAuth === true ? "no key is sent" : "the node's key is sent"}
          checked={media.noAuth === true}
          onChange={(v) => toggleNoAuth(v)}
        />
      </Card>
    </div>
  );
}
