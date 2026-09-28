// routy routing — model string resolution.
// Precedence: context-marker strip → alias → combo name → node prefix.
// Breaker-aware: routes carry a healthy flag; executors (P1.4) decide fallback.
import { log } from "../lib/log.mjs";
import { ttftOf } from "./latency.mjs";
import { priceOf } from "./pricing.mjs";
import { CHAT_KIND, MEDIA_KINDS, isMediaKind, mediaKindsOf, nodeServesKind, mediaUrlFor, authStyleFor, mediaConfigOf } from "./media.mjs";

// Claude Code marks 1M-context requests as "<model>[1m]" (upstream parity,
// 9router/src/sse/handlers/chat.js:51-55). Capability travels in headers, not the id.
const MARKER_RE = /^(.+)\[([a-z0-9]+)\]$/i;

export function stripContextMarker(modelStr) {
  if (typeof modelStr !== "string") return { modelStr, marker: null };
  const m = modelStr.match(MARKER_RE);
  return m ? { modelStr: m[1], marker: m[2] } : { modelStr, marker: null };
}

function breakerScopeFor(node) {
  return `node:${node.id}`;
}

export function isNodeHealthy(repos, node, now = Date.now()) {
  const b = repos.breakers.get(breakerScopeFor(node));
  if (!b) return true;
  if (b.state === "open") {
    if (b.openUntil && Date.parse(b.openUntil) > now) return false;
    return true; // open window expired — treat as healthy (half-open lands with executor probing, P1.4)
  }
  return true;
}

/**
 * Resolve a client model string to a routing target.
 * Returns one of:
 *   { kind: "node", node, model, marker, healthy }
 *   { kind: "combo", name, strategy, stickyLimit, routes: [{...nodeRoute, healthy}] }
 *   null (unresolvable)
 *
 * `options.kind` is which endpoint the request arrived on (`llm` by default). It is a
 * filter, not a preference: a media kind may only reach a node that declares it, and a
 * combo may only serve the kind it was created for. Without this an image request could
 * resolve to a chat model and be answered by it — the gateway's job is to refuse that,
 * not to guess.
 *
 * For kinds where the provider IS the model (`modelList: "none"`), a bare `<prefix>` with
 * no slash resolves with `model: null`.
 */
export function resolveRoute(repos, modelStr, { depth = 0, kind = CHAT_KIND } = {}) {
  if (typeof modelStr !== "string" || modelStr.length === 0 || depth > 3) return null;

  const { modelStr: stripped, marker } = stripContextMarker(modelStr);

  // 1. alias → target (single recursion via depth guard)
  const aliasTarget = repos.aliases.map()[stripped];
  if (aliasTarget && aliasTarget !== stripped) {
    const resolved = resolveRoute(repos, aliasTarget, { depth: depth + 1, kind });
    if (resolved) {
      return { ...resolved, marker: resolved.marker ?? marker };
    }
  }

  // 2. combo by name — only one that serves this kind
  const combo = repos.combos.byName(stripped);
  if (combo && (combo.kind || CHAT_KIND) === kind) {
    const routes = combo.models
      .map((m) => resolveRoute(repos, m, { depth: depth + 1, kind }))
      .filter(Boolean)
      .map((r) => ({ ...r, marker: r.marker ?? marker }));
    return {
      kind: "combo",
      id: combo.id,
      name: combo.name,
      strategy: combo.strategy || "fallback",
      stickyLimit: combo.stickyLimit ?? 1,
      routes,
    };
  }

  // 3. node prefix: "<nodePrefix>/<model>"
  const slash = stripped.indexOf("/");
  if (slash > 0) {
    const prefix = stripped.slice(0, slash);
    const model = stripped.slice(slash + 1);
    if (model.length > 0) {
      const node = repos.nodes.byPrefix(prefix);
      if (node && servesKind(node, kind)) {
        const healthy = node.enabled && isNodeHealthy(repos, node);
        return { kind: "node", node, model, marker, healthy };
      }
    }
  }

  // 4. bare "<nodePrefix>" — only when the provider IS the model for this kind
  if (slash === -1 && isMediaKind(kind) && MEDIA_KINDS[kind].modelList === "none") {
    const node = repos.nodes.byPrefix(stripped);
    if (node && servesKind(node, kind)) {
      const healthy = node.enabled && isNodeHealthy(repos, node);
      return { kind: "node", node, model: null, marker, healthy };
    }
  }

  // 5. bare "<model>" for kinds whose nodes register models (embedding, image).
  //    routy's own ids are "<prefix>/<model>", but a client that hands us the provider's
  //    own name — `whisper-1`, `text-embedding-3-small` — should reach it when exactly one
  //    node serving that kind carries that model. One match is a fact; two is a question only
  //    the caller can answer (which provider did you mean?), so an ambiguous id stays
  //    unresolvable rather than being silently answered by whichever node came first.
  if (slash === -1 && isMediaKind(kind) && MEDIA_KINDS[kind].modelList === "node") {
    const serving = repos.nodes.list({ enabled: true }).filter(
      (n) => servesKind(n, kind) && repos.nodeModels.list(n.id, { kind }).some((m) => m.model === stripped),
    );
    if (serving.length === 1) {
      const node = serving[0];
      return { kind: "node", node, model: stripped, marker, healthy: node.enabled && isNodeHealthy(repos, node) };
    }
    if (serving.length > 1 && depth === 0) {
      log.debug("ROUTE", `ambiguous bare model id for ${kind} — use <prefix>/<model>`, {
        modelStr,
        prefixes: serving.map((n) => n.prefix),
      });
    }
  }

  if (depth === 0) log.debug("ROUTE", `unresolvable model string`, { modelStr, kind });
  return null;
}

/** Chat is unrestricted (every node speaks it). A media kind must be declared. */
function servesKind(node, kind) {
  return kind === CHAT_KIND || nodeServesKind(node, kind);
}

// Strategies the UI offers and the API accepts. `round-robin` and `sticky` were both
// advertised in the combo editor (and sticky_limit has been in the schema since the
// start) but never reached dispatch: they fell through to declared order, and the API
// rejected saving them outright, so choosing either in the UI failed with a 400.
export const COMBO_STRATEGIES = Object.freeze(["fallback", "fastest", "cheapest", "round-robin", "sticky"]);

/**
 * Order combo routes for dispatch. Health always dominates: an unhealthy route
 * is never preferred just because it is fast or cheap, and rotation only ever
 * reorders the healthy ones — the side-lined routes stay at the back.
 *
 *   fallback    — declared order (default; what the user wrote is what runs)
 *   fastest     — by recent TTFT EWMA, unknown latency last
 *   cheapest    — by configured price, unpriced (unmetered) nodes first
 *   round-robin — start at a different member each request (caller supplies `rotate`)
 *   sticky      — same as round-robin but the caller advances `rotate` only every
 *                 stickyLimit requests, so a conversation keeps hitting one member
 *                 (prompt-cache affinity) before moving on
 */
export function orderRoutes(routes, { strategy = "fallback", rotate = 0 } = {}) {
  const healthy = routes.filter((r) => r.healthy && r.kind === "node");
  const rest = routes.filter((r) => !(r.healthy && r.kind === "node"));
  if (strategy === "fastest") {
    // Unknown latency sorts FIRST (optimistic initialisation). Ranking an untried
    // node last would keep it untried forever, so the router could never discover a
    // faster upstream — each node gets probed once, then ranked on real data.
    healthy.sort((a, b) => latencyRank(a.node.id) - latencyRank(b.node.id));
  } else if (strategy === "cheapest") {
    healthy.sort((a, b) => priceRank(a.node) - priceRank(b.node));
  } else if ((strategy === "round-robin" || strategy === "sticky") && healthy.length > 1) {
    // Rotate the starting position. The dispatch order after the wrap is unchanged,
    // so a failure still falls through to the members that follow.
    const at = ((Math.trunc(rotate) % healthy.length) + healthy.length) % healthy.length;
    healthy.push(...healthy.splice(0, at));
  }
  return [...healthy, ...rest];
}


function latencyRank(nodeId) {
  const v = ttftOf(nodeId);
  return v === null ? -1 : v;
}

function priceRank(node) {
  const price = priceOf(node);
  if (!price) return 0; // unmetered: cannot add cost, so it is the cheapest option
  return price.inputPer1M + price.outputPer1M;
}

/**
 * Enumerate client-visible models for GET /v1/models:
 * aliases (id = alias) + combos (id = combo name). Node-local models are
 * fetched upstream lazily (P1.4) and merged here.
 *
 * With `kind`, the same builder answers `/v1/models/<kind>`: nodes that declare that media
 * kind, and nothing else. The chat list is unchanged and must stay that way — it is the list
 * every connected client already reads, and a media model must not appear in it (a chat
 * request to an image model is a 400 from the provider, not a feature).
 *
 * Media entries carry their own `kind`, because `/v1/models/web` serves two kinds at once and
 * the client filters on it (9Router clients do the same).
 */
export function listModels(repos, { kind = CHAT_KIND } = {}) {
  const data = [];
  if (kind === CHAT_KIND) {
    for (const [alias] of Object.entries(repos.aliases.map())) {
      data.push({ id: alias, object: "model", owned_by: "routy-alias" });
    }
    for (const c of repos.combos.list()) {
      if ((c.kind || CHAT_KIND) !== CHAT_KIND) continue;
      data.push({ id: c.name, object: "model", owned_by: "routy-combo" });
    }
    for (const n of repos.nodes.list({ enabled: true })) {
      const models = repos.nodeModels.enabledModels(n.id, { kind: CHAT_KIND });
      if (models.length > 0) {
        for (const m of models) {
          data.push({ id: `${n.prefix}/${m}`, object: "model", owned_by: `routy-node:${n.prefix}` });
        }
      } else {
        // no models configured — expose the wildcard so the prefix is still discoverable
        data.push({ id: `${n.prefix}/*`, object: "model", owned_by: `routy-node:${n.prefix}` });
      }
    }
    return { object: "list", data };
  }

  if (!isMediaKind(kind)) return { object: "list", data };

  for (const c of repos.combos.list()) {
    if ((c.kind || CHAT_KIND) !== kind) continue;
    data.push({ id: c.name, object: "model", kind, owned_by: "routy-combo" });
  }

  const modelList = MEDIA_KINDS[kind].modelList;
  for (const n of repos.nodes.list({ enabled: true })) {
    if (!nodeServesKind(n, kind)) continue;
    if (modelList === "node") {
      for (const m of repos.nodeModels.enabledModels(n.id, { kind })) {
        data.push({ id: `${n.prefix}/${m}`, object: "model", kind, owned_by: `routy-node:${n.prefix}` });
      }
    } else {
      // The provider IS the model (web search/fetch), or the model field names a voice the
      // gateway cannot enumerate from here (tts) — either way the routable id is the prefix.
      data.push({ id: n.prefix, object: "model", kind, owned_by: `routy-node:${n.prefix}` });
    }
  }
  return { object: "list", data };
}

/**
 * Which kind is this id actually registered as?
 *
 * The id itself says it when the node has a model row for it: `m0probe/flux-1` registered as an
 * image model IS an image model, and answering "chat" for it would describe an endpoint that
 * cannot serve it. Chat is only the fallback for an id nothing knows — every node speaks chat,
 * so it is the one kind that is always true of a routable prefix.
 */
function inferKind(repos, modelStr) {
  const { modelStr: stripped } = stripContextMarker(modelStr);
  const slash = stripped.indexOf("/");
  if (slash > 0) {
    const node = repos.nodes.byPrefix(stripped.slice(0, slash));
    const row = node ? repos.nodeModels.byModel(node.id, stripped.slice(slash + 1)) : null;
    return row ? row.kind : CHAT_KIND;
  }
  // A bare "<model>": the rows that carry it say what kind it is. One kind across every match
  // is the answer; a model registered under two kinds is a question the caller answers by
  // prefixing (`<prefix>/<model>`), and chat is the default when nothing carries it.
  const kinds = new Set();
  for (const n of repos.nodes.list()) {
    for (const m of repos.nodeModels.list(n.id)) {
      if (m.model === stripped) kinds.add(m.kind);
      if (kinds.size > 1) return CHAT_KIND; // ambiguous → the loosest, most useful default
    }
  }
  if (kinds.size === 1) return [...kinds][0];
  // A bare prefix is only a routable id when the provider IS the model for this kind, so the
  // node's declared none-kinds are the candidates — and exactly one of them is the only
  // unambiguous answer.
  const node = repos.nodes.byPrefix(stripped);
  const candidates = node ? mediaKindsOf(node).filter((k) => MEDIA_KINDS[k].modelList === "none") : [];
  if (candidates.length === 1) return candidates[0];
  return CHAT_KIND;
}

/**
 * Effective dispatch config for one client model id — the payload behind
 * `/v1/models/info?id=`. Answers what a request for this id would actually do: which node,
 * which upstream URL, which auth style. This is the same information the dashboard's
 * provider card shows, and it is the honest answer to "why did my image request 400?".
 *
 * `kind` constrains the answer; omitting it asks routy to infer the kind from the id.
 */
export function modelInfo(repos, modelStr, { kind } = {}) {
  const effective = kind === undefined ? inferKind(repos, modelStr) : kind;
  const resolved = resolveRoute(repos, modelStr, { kind: effective });
  if (!resolved) return null;

  if (resolved.kind === "combo") {
    return {
      id: modelStr, object: "model-info", kind: effective,
      combo: true, strategy: resolved.strategy, stickyLimit: resolved.stickyLimit,
      members: resolved.routes.filter((r) => r.kind === "node").map((r) => `${r.node.prefix}/${r.model ?? ""}`.replace(/\/$/, "")),
    };
  }

  const node = resolved.node;
  const spec = isMediaKind(effective) ? MEDIA_KINDS[effective] : null;
  return {
    id: modelStr, object: "model-info", kind: effective,
    provider: node.prefix, model: resolved.model,
    endpoint: spec ? { method: spec.method, path: spec.path } : { method: "POST", path: "/v1/chat/completions" },
    url: spec ? mediaUrlFor(node, effective) : node.baseUrl,
    auth: { style: spec ? authStyleFor(node, effective) : "bearer" },
    noAuth: mediaConfigOf(node).noAuth,
    healthy: resolved.healthy,
  };
}

/**
 * The model ids to write into a CLI tool's own config — the same list `/v1/models` serves,
 * minus the `prefix/*` wildcard entries.
 *
 * A wildcard is a discovery affordance for a provider whose model list has not been fetched
 * yet; it is not a model id. A tool that stores it as one (pi lists whatever it is told, and
 * Claude Code routes whatever string it is handed) would offer the user a model that cannot
 * answer. Aliases and combos stay: those are real routable ids.
 */
export function toolModelIds(repos) {
  return listModels(repos).data.map((m) => m.id).filter((id) => !id.endsWith("/*"));
}
