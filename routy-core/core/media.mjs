// Media & web kinds — routy's port of 9Router's MEDIA_PROVIDER_KINDS
// (docs/media-providers.md §0). A kind IS the endpoint it serves, so this enum is the
// single place the two are kept in step: `/v1/models/<kind>` lists the models of a kind,
// `POST <path>` serves it, and a request's kind is decided by the path it arrived on —
// never by inspecting the body (an STT body is multipart we deliberately do not parse).
//
// Scope is deliberately six kinds. `video` is absent because a video create is a billable
// upstream job and needs a different rotation policy (never retry a create; rotate only on
// 401/403/429; never rotate a poll) — that belongs in a change of its own, not in a list.
// 9Router also declares `music`, but it has no route and no provider config there, so it is
// a placeholder we do not guess at.

/** The kinds routy serves. `modelList` says what discovery can enumerate for the kind:
 *   "node"   — the node's own model rows (a provider hosting several models)
 *   "voices" — no model list; the model field names a voice (TTS)
 *   "none"   — the provider IS the model (web search/fetch, and earlier 9Router parity)
 *  `logTag` is what a media request logs under, so the console can be filtered by kind.
 */
export const MEDIA_KINDS = Object.freeze({
  embedding: { label: "Embedding", method: "POST", path: "/v1/embeddings", modelList: "node", logTag: "EMBED" },
  image: { label: "Text to Image", method: "POST", path: "/v1/images/generations", modelList: "node", logTag: "IMAGE" },
  tts: { label: "Text To Speech", method: "POST", path: "/v1/audio/speech", modelList: "voices", logTag: "TTS" },
  stt: { label: "Speech To Text", method: "POST", path: "/v1/audio/transcriptions", modelList: "node", logTag: "STT" },
  webSearch: { label: "Web Search", method: "POST", path: "/v1/search", modelList: "none", logTag: "SEARCH" },
  webFetch: { label: "Web Fetch", method: "POST", path: "/v1/web/fetch", modelList: "none", logTag: "FETCH" },
});

export const MEDIA_KIND_IDS = Object.freeze(Object.keys(MEDIA_KINDS));

/** Chat. The default everywhere, and what a node serves when it declares nothing. */
export const CHAT_KIND = "llm";

/**
 * `/v1/models/web` carries both web kinds and clients filter by the entry's own `kind` —
 * 9Router does the same (`select(.kind=="webFetch")`), and it is why every media model
 * entry carries its kind rather than relying on the endpoint that returned it.
 */
export const KIND_ALIASES = Object.freeze({ web: ["webSearch", "webFetch"] });

/** How a credential is presented upstream. `none` is a real case, not an omission:
 *  local ComfyUI/SearXNG-style endpoints answer without auth. */
export const AUTH_STYLES = Object.freeze(["bearer", "token", "x-api-key", "key", "none"]);

export function isMediaKind(kind) {
  return Object.prototype.hasOwnProperty.call(MEDIA_KINDS, kind);
}

export function isKnownKind(kind) {
  return kind === CHAT_KIND || isMediaKind(kind);
}

/** Expand a kind id from a URL into the kinds it stands for ("web" → both). */
export function expandKind(kind) {
  if (KIND_ALIASES[kind]) return KIND_ALIASES[kind];
  return isMediaKind(kind) ? [kind] : [];
}

/** The kind a client path serves — the reverse of MEDIA_KINDS, for routing by endpoint. */
export function kindOfPath(pathname) {
  for (const [kind, spec] of Object.entries(MEDIA_KINDS)) {
    if (spec.path === pathname) return kind;
  }
  return null;
}

export function describeKind(kind) {
  const spec = MEDIA_KINDS[kind];
  return spec ? { id: kind, ...spec } : null;
}

/**
 * A node's media declaration, read defensively: `node.data` is user JSON and may predate
 * this feature, hold a typo, or have been written by hand through the API.
 */
export function mediaConfigOf(node) {
  const raw = node?.data?.media;
  if (!raw || typeof raw !== "object") return { kinds: [], urls: {}, auth: {}, noAuth: false, map: {} };
  return {
    kinds: Array.isArray(raw.kinds) ? raw.kinds.filter((k) => isMediaKind(k)) : [],
    urls: raw.urls && typeof raw.urls === "object" ? raw.urls : {},
    auth: raw.auth && typeof raw.auth === "object" ? raw.auth : {},
    noAuth: raw.noAuth === true,
    // The per-provider mapping (core/mediaMap.mjs) is config the handlers READ, so it has to
    // survive this filter — it is returned as written, because the write path is what validated
    // it and the engine is what interprets it. Dropping it here is not benign: every web request
    // then answers "no mapping" for a mapping the operator can see in the dashboard.
    map: raw.map && typeof raw.map === "object" ? raw.map : {},
  };
}

/** The kinds a node declares. Empty means "chat only", which is every node today. */
export function mediaKindsOf(node) {
  return mediaConfigOf(node).kinds;
}

export function nodeServesKind(node, kind) {
  return isMediaKind(kind) && mediaKindsOf(node).includes(kind);
}

/**
 * The upstream URL for a kind, or null when the node has not said.
 *
 * Only an explicit URL is returned. Deriving one from `baseUrl` by appending a path looks
 * helpful and is how a request reaches the wrong endpoint: `https://api.openai.com/v1` plus
 * `/v1/images/generations` is a 404, and providers disagree about whether the chat base
 * already ends in `/v1`. The adapter for each kind decides a default; this answers only
 * what the user wrote.
 */
export function mediaUrlFor(node, kind) {
  const url = mediaConfigOf(node).urls[kind];
  return typeof url === "string" && url.length > 0 ? url : null;
}

export function authStyleFor(node, kind) {
  const style = mediaConfigOf(node).auth[kind]?.style;
  if (typeof style === "string" && AUTH_STYLES.includes(style)) return style;
  return node?.data?.media?.noAuth === true ? "none" : "bearer";
}

/**
 * The credential header for a media call. Every style is a one-liner, and putting them here
 * is what keeps "the auth style a node declares" and "the header a request sends" the same
 * fact — an adapter that re-decides it is an adapter that can disagree with the config.
 * `none` returns nothing: a local endpoint that answers without a key is ready, not broken.
 */
export function authHeadersFor(style, secret) {
  if (!secret || style === "none") return {};
  switch (style) {
    case "token": return { Authorization: `Token ${secret}` };
    case "x-api-key": return { "x-api-key": secret };
    case "key": return { Authorization: `Key ${secret}` };
    default: return { Authorization: `Bearer ${secret}` };
  }
}

/**
 * Validate a `node.data.media` value from the API.
 *
 * Unknown keys are rejected rather than ignored: `url` for `urls` would otherwise be a
 * config the user can see and that silently does nothing, which is the failure mode this
 * repo treats as a defect (see the combo editor write-through in v0.1.23).
 *
 * @returns {{ ok: true, value: object } | { ok: false, detail: string }}
 */
export function validateMediaConfig(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: "media must be an object" };
  }

  const known = new Set(["kinds", "urls", "auth", "noAuth", "map"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      return { ok: false, detail: `media.${key} is not a setting (expected one of: ${[...known].join(", ")})` };
    }
  }

  const out = {};

  if (value.kinds !== undefined) {
    if (!Array.isArray(value.kinds)) return { ok: false, detail: "media.kinds must be an array" };
    for (const kind of value.kinds) {
      if (!isMediaKind(kind)) {
        return { ok: false, detail: `media.kinds: "${kind}" is not a kind (known: ${MEDIA_KIND_IDS.join(", ")})` };
      }
    }
    out.kinds = [...new Set(value.kinds)];
  }

  if (value.urls !== undefined) {
    if (typeof value.urls !== "object" || value.urls === null || Array.isArray(value.urls)) {
      return { ok: false, detail: "media.urls must be an object of kind → URL" };
    }
    out.urls = {};
    for (const [kind, url] of Object.entries(value.urls)) {
      if (!isMediaKind(kind)) return { ok: false, detail: `media.urls.${kind} is not a kind` };
      if (typeof url !== "string" || url.length === 0) {
        return { ok: false, detail: `media.urls.${kind} must be a URL string` };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { ok: false, detail: `media.urls.${kind} is not a valid URL` }; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, detail: `media.urls.${kind} must be http(s), not ${parsed.protocol}` };
      }
      out.urls[kind] = url;
    }
  }

  if (value.auth !== undefined) {
    if (typeof value.auth !== "object" || value.auth === null || Array.isArray(value.auth)) {
      return { ok: false, detail: "media.auth must be an object of kind → { style }" };
    }
    out.auth = {};
    for (const [kind, spec] of Object.entries(value.auth)) {
      if (!isMediaKind(kind)) return { ok: false, detail: `media.auth.${kind} is not a kind` };
      const style = spec?.style;
      if (!AUTH_STYLES.includes(style)) {
        return { ok: false, detail: `media.auth.${kind}.style must be one of: ${AUTH_STYLES.join(", ")}` };
      }
      out.auth[kind] = { style };
    }
  }

  if (value.noAuth !== undefined) {
    if (typeof value.noAuth !== "boolean") return { ok: false, detail: "media.noAuth must be true or false" };
    out.noAuth = value.noAuth;
  }

  /**
   * The web kinds need a per-provider mapping (core/mediaMap.mjs): they share no wire format, so
   * the differences are configuration. Validated hard and early for the reason every other field
   * here is — a malformed mapping would otherwise fail as a provider 400 that looks like the
   * provider's fault, or send a header a typo invented.
   */
  if (value.map !== undefined) {
    if (typeof value.map !== "object" || value.map === null || Array.isArray(value.map)) {
      return { ok: false, detail: "media.map must be an object of kind → mapping" };
    }
    out.map = {};
    for (const [kind, spec] of Object.entries(value.map)) {
      if (!isMediaKind(kind)) return { ok: false, detail: `media.map.${kind} is not a kind` };
      if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
        return { ok: false, detail: `media.map.${kind} must be an object` };
      }
      const knownMap = ["method", "in", "headers", "request", "response", "raw"];
      for (const k of Object.keys(spec)) {
        if (!knownMap.includes(k)) {
          return { ok: false, detail: `media.map.${kind}.${k} is not a setting (expected one of: ${knownMap.join(", ")})` };
        }
      }
      const specOut = {};

      if (spec.method !== undefined && spec.method !== "POST" && spec.method !== "GET") {
        return { ok: false, detail: `media.map.${kind}.method must be POST or GET` };
      }
      if (spec.method !== undefined) specOut.method = spec.method;
      if (spec.in !== undefined && spec.in !== "body" && spec.in !== "query") {
        return { ok: false, detail: `media.map.${kind}.in must be body or query` };
      }
      if (spec.in !== undefined) specOut.in = spec.in;
      if (spec.raw !== undefined) {
        if (typeof spec.raw !== "boolean") return { ok: false, detail: `media.map.${kind}.raw must be true or false` };
        specOut.raw = spec.raw;
      }

      /** A rename table: every value a non-empty string, no CR/LF where a header is built. */
      const stringMap = (obj, label, { headerSafe = false } = {}) => {
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
          return { ok: false, detail: `media.map.${kind}.${label} must be an object of strings` };
        }
        const built = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v !== "string") return { ok: false, detail: `media.map.${kind}.${label}.${k} must be a string` };
          if (headerSafe) {
            // A header value is not a free-form string: CR/LF lets a caller end one header and
            // start another, and an empty name is a header nobody can read. `authorization` is
            // refused because credentials belong to the connection, not to a config the operator
            // edits once — a static one would silently override every key on the node.
            if (k.trim().length === 0 || /[\r\n]/.test(k) || /[\r\n]/.test(v)) {
              return { ok: false, detail: `media.map.${kind}.headers needs a name and a value without newlines` };
            }
            if (/^authorization$/i.test(k.trim())) {
              return { ok: false, detail: `media.map.${kind}.headers cannot set authorization — the credential comes from the connection` };
            }
          } else if (!v.trim()) {
            return { ok: false, detail: `media.map.${kind}.${label}.${k} maps to an empty path` };
          }
          built[k] = v;
        }
        return { ok: true, value: built };
      };

      if (spec.headers !== undefined) {
        const r = stringMap(spec.headers, "headers", { headerSafe: true });
        if (!r.ok) return r;
        specOut.headers = r.value;
      }
      if (spec.request !== undefined) {
        const r = stringMap(spec.request, "request");
        if (!r.ok) return r;
        specOut.request = r.value;
      }
      if (spec.response !== undefined) {
        const resp = spec.response;
        if (typeof resp !== "object" || resp === null || Array.isArray(resp)) {
          return { ok: false, detail: `media.map.${kind}.response must be an object` };
        }
        const knownResp = ["results", "fields", "top"];
        for (const k of Object.keys(resp)) {
          if (!knownResp.includes(k)) {
            return { ok: false, detail: `media.map.${kind}.response.${k} is not a setting (expected one of: ${knownResp.join(", ")})` };
          }
        }
        const respOut = {};
        if (resp.results !== undefined) {
          if (typeof resp.results !== "string" || !resp.results) {
            return { ok: false, detail: `media.map.${kind}.response.results must be a non-empty path string` };
          }
          respOut.results = resp.results;
        }
        for (const label of ["fields", "top"]) {
          if (resp[label] === undefined) continue;
          const r = stringMap(resp[label], `response.${label}`);
          if (!r.ok) return r;
          respOut[label] = r.value;
        }
        specOut.response = respOut;
      }
      out.map[kind] = specOut;
    }
  }

  return { ok: true, value: out };
}
