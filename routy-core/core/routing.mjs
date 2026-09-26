// routy routing — model string resolution.
// Precedence: context-marker strip → alias → combo name → node prefix.
// Breaker-aware: routes carry a healthy flag; executors (P1.4) decide fallback.
import { log } from "../lib/log.mjs";
import { ttftOf } from "./latency.mjs";
import { priceOf } from "./pricing.mjs";

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
 */
export function resolveRoute(repos, modelStr, { depth = 0 } = {}) {
  if (typeof modelStr !== "string" || modelStr.length === 0 || depth > 3) return null;

  const { modelStr: stripped, marker } = stripContextMarker(modelStr);

  // 1. alias → target (single recursion via depth guard)
  const aliasTarget = repos.aliases.map()[stripped];
  if (aliasTarget && aliasTarget !== stripped) {
    const resolved = resolveRoute(repos, aliasTarget, { depth: depth + 1 });
    if (resolved) {
      return { ...resolved, marker: resolved.marker ?? marker };
    }
  }

  // 2. combo by name
  const combo = repos.combos.byName(stripped);
  if (combo) {
    const routes = combo.models
      .map((m) => resolveRoute(repos, m, { depth: depth + 1 }))
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
      if (node) {
        const healthy = node.enabled && isNodeHealthy(repos, node);
        return { kind: "node", node, model, marker, healthy };
      }
    }
  }

  if (depth === 0) log.debug("ROUTE", `unresolvable model string`, { modelStr });
  return null;
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
 */
export function listModels(repos) {
  const data = [];
  for (const [alias] of Object.entries(repos.aliases.map())) {
    data.push({ id: alias, object: "model", owned_by: "routy-alias" });
  }
  for (const c of repos.combos.list()) {
    data.push({ id: c.name, object: "model", owned_by: "routy-combo" });
  }
  for (const n of repos.nodes.list({ enabled: true })) {
    const models = repos.nodeModels.enabledModels(n.id);
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
