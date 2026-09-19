// RE-E routing — model string resolution.
// Precedence: context-marker strip → alias → combo name → node prefix.
// Breaker-aware: routes carry a healthy flag; executors (P1.4) decide fallback.
import { log } from "../lib/log.mjs";

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

/**
 * Enumerate client-visible models for GET /v1/models:
 * aliases (id = alias) + combos (id = combo name). Node-local models are
 * fetched upstream lazily (P1.4) and merged here.
 */
export function listModels(repos) {
  const data = [];
  for (const [alias] of Object.entries(repos.aliases.map())) {
    data.push({ id: alias, object: "model", owned_by: "re-e-alias" });
  }
  for (const c of repos.combos.list()) {
    data.push({ id: c.name, object: "model", owned_by: "re-e-combo" });
  }
  for (const n of repos.nodes.list({ enabled: true })) {
    const models = Array.isArray(n.data?.models) ? n.data.models : [];
    if (models.length > 0) {
      for (const m of models) {
        data.push({ id: `${n.prefix}/${m}`, object: "model", owned_by: `re-e-node:${n.prefix}` });
      }
    } else {
      // no cached model list — expose the wildcard so the prefix is still discoverable
      data.push({ id: `${n.prefix}/*`, object: "model", owned_by: `re-e-node:${n.prefix}` });
    }
  }
  return { object: "list", data };
}
