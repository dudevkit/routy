// routy proxy surface — the endpoints a client, SDK or CLI tool calls.
//
// The twin of http/api.mjs, which serves the dashboard: /api is management, /v1 is traffic.
// It lives in its own module so each media kind can add its route beside the others instead
// of growing server.mjs, and so the whole surface is testable without booting a gateway.
//
// A request's KIND is decided by the path it arrived on, never by inspecting the body. That
// is not a style choice: an STT body is multipart and is forwarded byte-for-byte (re-encoding
// it would change the boundary), so nothing here may parse a body to find out what it is.
import { json } from "../lib/router.mjs";
import { listModels, modelInfo } from "../core/routing.mjs";
import { CHAT_KIND, MEDIA_KINDS, MEDIA_KIND_IDS, expandKind, isKnownKind, mediaKindsOf } from "../core/media.mjs";

export function buildProxyRoutes(repos, { chatHandler, handlers = {} }) {
  /** The kinds a `/v1/models/<kind>` path may name, alias included ("web" → both web kinds). */
  const kindsForPath = (name) => {
    const expanded = expandKind(name);
    if (expanded.length > 0) return expanded;
    return null;
  };

  return [
    // Chat discovery. Unchanged output — every connected client already reads this list.
    {
      method: "GET", pattern: /^\/v1\/models$/,
      handler: async (req, res) => json(res, 200, listModels(repos)),
    },

    // Per-model dispatch config. Declared BEFORE the kind route, which would otherwise read
    // "info" as a kind name and 404 it.
    {
      method: "GET", pattern: /^\/v1\/models\/info$/,
      handler: async (req, res, _params, url) => {
        const id = url.searchParams.get("id");
        if (!id) {
          return json(res, 400, { error: { message: "bad_request", detail: "id is required, e.g. /v1/models/info?id=jina-reader" } });
        }
        const asked = url.searchParams.get("kind");
        if (asked && !isKnownKind(asked)) {
          return json(res, 400, { error: { message: "bad_request", detail: `kind "${asked}" is not a kind (known: ${CHAT_KIND}, ${MEDIA_KIND_IDS.join(", ")})` } });
        }
        // An explicit kind is a constraint — the caller is saying where it intends to send this.
        // Without one, routy infers from the id (routing.mjs `inferKind`): a model registered as
        // an image model is an image model, and answering "chat" for it would name an endpoint
        // that cannot serve it.
        const info = asked ? modelInfo(repos, id, { kind: asked }) : modelInfo(repos, id);
        if (info) return json(res, 200, info);

        // Actionable refusal: name what this prefix CAN do, since a bare prefix with two web
        // kinds is a genuine ambiguity that only the caller can settle.
        const prefix = id.split("/")[0];
        const node = repos.nodes.byPrefix(prefix);
        const declared = node ? mediaKindsOf(node) : [];
        const hint = asked
          ? `"${id}" is not routable as ${asked}`
          : declared.length > 1
            ? `"${id}" is routable as more than one kind (${declared.join(", ")}) — name one with ?kind=`
            : `"${id}" is not routable — check the prefix, or that the node declares the kind`;
        return json(res, 404, { error: { message: "not_found", detail: hint } });
      },
    },

    // Per-kind model discovery: /v1/models/embedding, /image, /tts, /stt, /web.
    // `/v1/models/web` carries both web kinds; each entry names its own kind, so a client
    // filters on the entry rather than on which endpoint returned it (9Router clients do).
    {
      method: "GET", pattern: /^\/v1\/models\/(?<kind>[A-Za-z]+)$/,
      handler: async (req, res, params) => {
        const kinds = kindsForPath(params.kind);
        if (!kinds) {
          return json(res, 404, {
            error: {
              message: "not_found",
              detail: `"${params.kind}" is not a kind (known: ${[...new Set([...MEDIA_KIND_IDS, "web"])].join(", ")})`,
            },
          });
        }
        if (kinds.length === 1) return json(res, 200, listModels(repos, { kind: kinds[0] }));
        const data = kinds.flatMap((kind) => listModels(repos, { kind }).data);
        return json(res, 200, { object: "list", data });
      },
    },

    // Media traffic. Every media kind is declared here as its own route, so the endpoint a
    // request arrives on is what decides its kind — handlers never inspect a body to find out.
    ...(handlers.embeddings
      ? [{ method: "POST", pattern: /^\/v1\/embeddings$/, handler: handlers.embeddings }]
      : []),
    ...(handlers.images
      ? [{ method: "POST", pattern: /^\/v1\/images\/generations$/, handler: handlers.images }]
      : []),

    // Chat traffic. Both paths land on the same handler (source format is detected per
    // request from the endpoint and the body).
    { method: "POST", pattern: /^\/v1\/chat\/completions$/, handler: chatHandler },
    { method: "POST", pattern: /^\/v1\/messages$/, handler: chatHandler },
  ];
}

/** Every kind path this module serves — for the dashboard's "what can I call" list. */
export function proxyEndpoints() {
  return [
    { method: "GET", path: "/v1/models", kind: CHAT_KIND, label: "Model list (chat)" },
    { method: "GET", path: "/v1/models/<kind>", kind: null, label: "Model list (per kind)" },
    { method: "GET", path: "/v1/models/info", kind: null, label: "Model dispatch config" },
    ...Object.entries(MEDIA_KINDS).map(([kind, spec]) => ({ method: spec.method, path: spec.path, kind, label: spec.label })),
    { method: "POST", path: "/v1/chat/completions", kind: CHAT_KIND, label: "Chat" },
    { method: "POST", path: "/v1/messages", kind: CHAT_KIND, label: "Chat (Claude dialect)" },
  ];
}
