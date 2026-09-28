/**
 * The declarative provider mapping for the web kinds.
 *
 * Web search and fetch are the two kinds whose providers share *no* wire format: `query` here is
 * `q` there, results live at `results` or `hits` or under a nested key, and one provider answers
 * GET with query params while another POSTs JSON. Under the rule this feature was built on —
 * all providers similar, differences are data — every one of those differences is expressed as a
 * mapping in `node.data.media.map[kind]`, and this module is the one engine that executes it.
 * A provider with no mapping is not a provider routy can call; there is no code path that
 * guesses, because a guess sends fields the provider rejects.
 *
 * Mapping shape (each entry validated by validateMediaConfig in core/media.mjs):
 *   method?     "POST" | "GET"                     default POST
 *   in?         "body" | "query"                   default: GET ⇒ query, POST ⇒ body
 *   headers?    { name: literal }                  static per-provider headers
 *   static?     { providerField: literal }         fixed values the provider always wants
 *   request?    { routy.path: providerField }      renames; only what is named is sent
 *   arrays?     [providerField, ...]               wrap those values in a one-element list
 *   authQuery?  providerParam                      the credential goes in the query under this name
 *   response?   { results?, fields?, top?, text?, titleRegex? }
 *                 results     dotted path to the items array (search)
 *                 fields      routy.path ← provider.path, per item (search) / whole body (fetch)
 *                 top         routy.path ← provider.path, top level (answer, pagination, usage)
 *                 text        the body IS the content (a text/markdown provider, not JSON)
 *                 titleRegex  one regex, or a list tried in order, group 1 is the title
 *   raw?        provider already speaks routy's shape → returned untouched
 *
 * Routed request fields are dotted paths in both directions, so `provider_options.cursor` can map
 * to `cursor` without a special case, and a nested routy field (`content.text`) can be built from
 * a flat provider one. Response paths accept `a|b` (first present) and numeric segments (`items.0`).
 */

/**
 * Read a dotted path (`""` → the value itself).
 *
 * Two things beyond plain drilling, both because real providers need them and both cheaper than a
 * per-provider code path:
 *   - `a|b|c` is a fallback chain. Providers put the same fact in different places depending on
 *     what they chose to return (Firecrawl answers `data.markdown`, `data.html` or `data.text` for
 *     the same page), and "the first one that is there" is the data form of that rule.
 *   - a numeric segment indexes an array. Five of the six fetch providers wrap the page in a
 *     one-element list, so `results.0.raw_content` is their normal shape, not an exception.
 */
export function getPath(source, path) {
  if (path === undefined || path === null || path === "") return source;
  const text = String(path);
  if (text.includes("|")) {
    for (const alt of text.split("|")) {
      const value = getPath(source, alt.trim());
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }
  let cur = source;
  for (const seg of text.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}

/** Write a dotted path into an object, creating intermediate objects. */
export function setPath(target, path, value) {
  const segs = String(path).split(".");
  let cur = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
  return target;
}

/**
 * Build the upstream call from routy's request body and the provider's mapping.
 *
 * Only fields the mapping NAMES are sent — a field routy understands and this provider does not
 * is dropped rather than forwarded, which is the same rule chat's param table applies to bodies:
 * an unwanted field is a 400 the caller should never see.
 *
 * @returns {{ method: "GET"|"POST", url: string, body: string }}
 */
export function buildUpstreamRequest({ baseUrl, body, map, secret = null }) {
  const method = (map.method ?? (map.in === "query" ? "GET" : "POST")).toUpperCase();
  const target = map.in ?? (method === "GET" ? "query" : "body");

  // Fixed values first, renames second, so a rename into the same field wins: `static` says what
  // the provider always wants (Exa's `text: true`, Linkup's `outputType`), the rename says what
  // the request carries.
  const payload = {};
  for (const [k, v] of Object.entries(map.static ?? {})) payload[k] = v;
  for (const [source, dest] of Object.entries(map.request ?? {})) {
    const value = getPath(body, source);
    if (value === undefined || value === null) continue;
    payload[dest] = value;
  }

  // A provider that wants a LIST where routy has one value: Tavily extract takes `urls: [u]`,
  // Exa contents `ids: [u]`, Firecrawl `formats: [fmt]`.
  for (const field of map.arrays ?? []) {
    if (payload[field] !== undefined && !Array.isArray(payload[field])) payload[field] = [payload[field]];
  }

  // A credential that travels in the query string (Google PSE's `key`, SearchAPI's `api_key`).
  // It goes in from the CONNECTION's secret, never from the mapping — the same rule that keeps
  // `authorization` out of static headers.
  if (map.authQuery && secret) payload[map.authQuery] = secret;

  const url = String(baseUrl).replace(/\/+$/, "");
  if (target === "query") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(payload)) qs.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    return { method, url: `${url}?${qs.toString()}`, body: "" };
  }
  return { method, url, body: JSON.stringify(payload) };
}

/** Static headers from the mapping, plus nothing else — no implicit content-type games. */
export function headersFor(map) {
  const out = {};
  for (const [k, v] of Object.entries(map.headers ?? {})) out[k] = v;
  return out;
}

function finishMetrics(out, responseTimeMs, upstreamMs) {
  out.usage = typeof out.usage === "object" && out.usage !== null ? out.usage : {};
  out.metrics = typeof out.metrics === "object" && out.metrics !== null ? out.metrics : {};
  out.errors = Array.isArray(out.errors) ? out.errors : [];
  if (responseTimeMs !== undefined) out.metrics.response_time_ms = responseTimeMs;
  if (upstreamMs !== undefined) out.metrics.upstream_latency_ms = upstreamMs;
  return out;
}

/**
 * Normalize a provider's search answer into routy's documented shape (docs §1.5):
 *   { provider, query, results[], answer?, usage, metrics, errors }
 *
 * `position` is filled in when the provider did not send one, so a client ranking results by it
 * is never left with gaps.
 */
export function normalizeSearch(raw, { map, provider, query, responseTimeMs, upstreamMs }) {
  if (map.raw) return raw;
  const items = Array.isArray(raw) ? raw : getPath(raw, map.response?.results ?? "");
  const list = Array.isArray(items) ? items : [];

  const results = list.map((item, i) => {
    const out = {};
    for (const [dest, source] of Object.entries(map.response?.fields ?? {})) {
      const value = getPath(item, source);
      if (value !== undefined) setPath(out, dest, value);
    }
    if (out.position === undefined) out.position = i + 1;
    return out;
  });

  const out = { provider, query, results };
  for (const [dest, source] of Object.entries(map.response?.top ?? {})) {
    const value = getPath(raw, source);
    if (value !== undefined) setPath(out, dest, value);
  }
  return finishMetrics(out, responseTimeMs, upstreamMs);
}

/**
 * Normalize a provider's fetch answer into routy's shape (docs §1.6):
 *   { provider, url, title, content{format,text,length}, links[], metadata, usage, metrics }
 *
 * The computed fields are computed: `content.format` is what the CLIENT asked for (the provider
 * did not choose it), `content.length` is the truth about the text we are about to send, and
 * `url` is the request's own target. `maxCharacters` truncates here, at the edge — one rule for
 * every provider rather than a per-provider one.
 */
export function normalizeFetch(raw, { map, provider, requestedUrl, format, maxCharacters, responseTimeMs, upstreamMs }) {
  if (map.raw) return raw;
  const out = { provider, url: requestedUrl };

  // `response.text` marks a provider that answers with the page itself rather than JSON — Jina
  // Reader's whole interface. The body IS the content, and the title, when the provider prefixes
  // one, comes from a regex over that same text (`Title: …`, else the first Markdown heading).
  if (map.response?.text) {
    const text = typeof raw === "string" ? raw : String(raw ?? "");
    out.content = { text };
    for (const pattern of [].concat(map.response.titleRegex ?? [])) {
      const m = new RegExp(pattern, "im").exec(text);
      if (m && m[1]) { out.title = m[1].trim(); break; }
    }
  }

  for (const [dest, source] of Object.entries(map.response?.fields ?? {})) {
    const value = getPath(raw, source);
    if (value !== undefined) setPath(out, dest, value);
  }
  for (const [dest, source] of Object.entries(map.response?.top ?? {})) {
    const value = getPath(raw, source);
    if (value !== undefined) setPath(out, dest, value);
  }

  let text = out.content?.text;
  if (typeof text !== "string") text = "";
  // `0` means "no truncation" — it is how the reference clients ask for the whole page.
  if (Number.isFinite(maxCharacters) && maxCharacters > 0 && text.length > maxCharacters) {
    text = text.slice(0, maxCharacters);
    out.truncated = true;
  }
  out.content = { format: format ?? "markdown", text, length: text.length };
  out.links = Array.isArray(out.links) ? out.links : [];
  out.metadata = typeof out.metadata === "object" && out.metadata !== null ? out.metadata : {};
  return finishMetrics(out, responseTimeMs, upstreamMs);
}
