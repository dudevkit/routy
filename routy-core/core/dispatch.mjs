// Dispatch policy shared by every kind: which key serves a request, and what a failure is
// allowed to cost a node.
//
// These lived inside the chat handler because chat was the only endpoint. They are not chat
// policy — they are the gateway's policy, and a media request must obey the same rules rather
// than grow a second, subtly different copy of them. (The copy is always where the bug is: a
// rotation that skips a cooling key in one handler and not the other is invisible until a
// provider is failing.)
import { classifyConnectionError, recordConnectionFailure, connectionState, isConnectionAvailable, earliestRecovery } from "./key-health.mjs";
import { FAILURE_THRESHOLD, OPEN_MS, MAX_OPEN_MS, UPSTREAM_429_MEMO_MS } from "./limits.mjs";
import { maskKey } from "../lib/mask.mjs";
import { json } from "../lib/router.mjs";
import { costOf, isMetered } from "./pricing.mjs";
import { addSpend, budgetState } from "./budget.mjs";
import { orderRoutes } from "./routing.mjs";
import { MEDIA_KINDS } from "./media.mjs";

// nodeId -> rotation cursor. Key rotation is per node and per process (RAM): a restart
// forgetting the cursor merely starts the rotation over.
const rrCursor = new Map();

/**
 * Keys of `node` in dispatch order: active in the DB, not cooling/disabled in the
 * health store, then ordered by the provider's key strategy. Empty means nothing to
 * serve with.
 *
 *   round-robin (default) — start at a different key each request, spreading load
 *   fallback              — always start at the first usable key, so a primary key
 *                           carries everything until it fails; the failover to the
 *                           next key still happens inside the same request
 */
export function pickConnections(repos, node) {
  const usable = repos.connections.list(node.id)
    .filter((c) => c.status === "active")
    .filter((c) => isConnectionAvailable(connectionState(repos, c.id)));
  if (usable.length === 0) return [];
  if (node.data?.keyStrategy === "fallback") return usable;
  const start = rrCursor.get(node.id) ?? 0;
  rrCursor.set(node.id, start + 1);
  const at = start % usable.length;
  return [...usable.slice(at), ...usable.slice(0, at)];
}

/** Per-node set of connection ids that 429'd during this request's rotation. */
export function recent429For(map, nodeId) {
  let set = map.get(nodeId);
  if (!set) { set = new Set(); map.set(nodeId, set); }
  return set;
}

/** Charge a failure to the node's breaker — 5xx, timeouts, a stalled upstream. */
export function recordFailure(repos, node, err) {
  const scope = `node:${node.id}`;
  const cur = repos.breakers.record(scope, { failureDelta: 1, lastError: `${err.errorCode}: ${(err.message || "").slice(0, 200)}` });
  if (cur.failures >= FAILURE_THRESHOLD) {
    // Exponential backoff on consecutive failures: the first trip opens for
    // OPEN_MS, and each failed half-open probe doubles it up to MAX_OPEN_MS.
    // A success resets the count, so a recovered node is back to base.
    const exp = cur.failures - FAILURE_THRESHOLD;
    const openMs = Math.min(OPEN_MS * 2 ** exp, MAX_OPEN_MS);
    repos.breakers.record(scope, {
      state: "open",
      openUntil: new Date(Date.now() + openMs).toISOString(),
    });
  }
}

/** A served request clears the node's breaker, whatever it was carrying. */
export function recordSuccess(repos, node) {
  repos.breakers.record(`node:${node.id}`, { state: "closed", failures: 0, openUntil: null, lastError: null });
}

/**
 * Usage + budget + the console line for a NON-chat request.
 *
 * Written once for every media kind rather than once per kind, so a budget the user set is
 * enforced identically on an image as on a chat message. `usage` is token-shaped because the
 * first media kind (embeddings) reports real token usage; kinds that do not — images, seconds
 * of audio — pass what they have and leave the rest null rather than inventing a zero, since a
 * recorded zero looks like data.
 */
export function recordMediaUsage(repos, log, { route, connection, clientModel, kind, status, usage = {}, durationMs, apiKeyId = null, pool = null, attempts = 1, combo = null }) {
  const costUsd = costOf(route.node, { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens });
  if (Number.isFinite(costUsd)) addSpend(costUsd);

  const event = repos.usage.record({
    nodeId: route.node.id,
    connectionId: connection.id,
    apiKeyId,
    model: clientModel,
    kind,
    status,
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    costUsd: Number.isFinite(costUsd) ? Number(costUsd.toFixed(6)) : null,
    durationMs,
  });

  // A combo request names its member and where that member sat in the strategy's order —
  // without it the line cannot tell a correct `fallback` (member 1 by design) from broken
  // rotation (member 1 every time). Same shape chat's request line uses.
  log.info(kindTag(kind), combo ? `${combo.name} → ${combo.member} ← ${status} · try ${combo.attempt}/${combo.of}` : `${route.node.prefix} ← ${status}`, {
    requestId: event.id,
    kind,
    model: clientModel,
    nodeId: route.node.id,
    connectionId: connection.id,
    key: `${connection.name} (${maskKey(connection.credentials?.apiKey)})`,
    ...(combo
      ? { combo: combo.name, strategy: combo.strategy, member: combo.member, attempt: combo.attempt, of: combo.of, order: combo.order, skipped: combo.skipped }
      : {}),
    pool,
    status,
    attempts,
    durationMs,
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    costUsd: Number.isFinite(costUsd) ? Number(costUsd.toFixed(6)) : null,
  });
  return event.id;
}

/**
 * What a failed upstream attempt is allowed to cost, decided once for every kind.
 *
 * Chat, embeddings, images and the rest must agree on this: a 400 is the caller's, a 429 that
 * names the provider is nobody's, a 5xx is the node's and stops key rotation, a per-key 429
 * cools that key and moves on. Returning a decision instead of branching inside the caller
 * keeps one definition of the rule while leaving each handler free to shape its own response.
 *
 * @returns {{action: "aborted"}} |
 *           {action: "proxy", providerLevel: boolean} |
 *           {action: "client"} |                                     // no health charged
 *           {action: "global", retryAfterMs: number, until: number} | // 429 for everyone
 *           {action: "node"} |                                       // breaker + stop keys
 *           {action: "key", verdict: string, reason?: string}
 */
export function settleFailure(repos, { node, connection, result, settings = {}, recent429 = null, cooledHere = [], tag = "GATEWAY", log = null }) {
  if (result.errorCode === "client_aborted") return { action: "aborted" };

  // Our own egress failing says nothing about the provider or the key: three dead proxies
  // must not open a healthy node's breaker, nor cool its keys.
  if (result.errorCode === "proxy_failed" || result.errorCode === "proxy_exhausted") {
    log?.warn?.(tag, `node ${node.prefix}: ${result.errorCode} — ${result.message}`);
    return { action: "proxy", providerLevel: result.proxySource === "provider" };
  }

  // A request-shaped 4xx (400/413/422) is the caller's mistake. Charging it to the node is
  // what turns one unsupported field into an outage — three such requests used to open a
  // provider's breaker and 503 every later request on it.
  if (classifyConnectionError(result, { connection, recent429: null }).verdict === "client") {
    log?.warn?.(tag, `node ${node.prefix} rejected the request (${result.status}) — no health recorded`, {
      detail: String(result.message || "").slice(0, 200),
    });
    return { action: "client" };
  }

  const verdict = recordConnectionFailure(repos, connection, result, settings, Date.now(), recent429);

  if (verdict.verdict === "global") {
    // Provider-wide saturation: no key is at fault, so a cooldown this request already
    // applied was based on evidence that has just been overruled — put it back.
    for (const id of cooledHere) recordSuccess(repos, id);
    const until = Date.now() + (result.retryAfterMs ?? UPSTREAM_429_MEMO_MS);
    log?.warn?.(tag, `node ${node.prefix}: upstream-wide rate limit — not a key problem, failing through`, {
      errorCode: result.errorCode, rolledBack: cooledHere.length,
    });
    return { action: "global", retryAfterMs: Math.max(0, until - Date.now()), until, others: verdict.others ?? 0 };
  }

  if (verdict.verdict === "node") {
    recordFailure(repos, node, result);
    log?.warn?.(tag, `node ${node.prefix} failed: ${result.errorCode} ${result.status ?? ""}`);
    return { action: "node" };
  }

  // Only a cooldown is rollback-able; a disable is a strike the key earned.
  if (verdict.verdict === "cooldown") cooledHere.push(connection.id);
  log?.warn?.(tag, `node ${node.prefix}: key ${connection.name} — ${verdict.verdict} (${result.errorCode})`, {
    reason: verdict.reason, status: result.status ?? null,
  });
  return { action: "key", verdict: verdict.verdict, reason: verdict.reason };
}

/**
 * What a request will be dispatched to, decided the same way for every kind.
 *
 * This is the preamble the chat handler grew first: strategy order, the daily budget dropping
 * metered routes, breaker state deciding availability, and the combo description the console
 * needs to tell correct rotation from a stuck first member. Media requests must agree with chat
 * on all four — a breaker that silences a node for chat while media keeps hammering it is the
 * kind of split-brain this module exists to prevent.
 *
 * @returns {{ ordered, routes, candidates, combo, budget, retryAfterMs }}
 */
export function dispatchPlan(repos, route, { settings = {} } = {}) {
  const ordered = route.kind === "combo"
    ? orderRoutes(route.routes, {
        strategy: route.strategy,
        rotate: comboTurn(route.id ?? route.name, route.strategy, route.stickyLimit),
      })
    : [route];

  const budget = budgetState(settings.budgetUsdPerDay);
  const routes = budget.over ? ordered.filter((r) => r.kind === "node" && !isMetered(r.node)) : ordered;

  // Fail fast when every route has an open breaker — hammering a dead upstream is what the
  // breaker exists to prevent.
  const candidates = routes.filter((r) => r.kind === "node" && r.healthy);
  const combo = route.kind === "combo" ? describeCombo(repos, route, ordered, routes, candidates) : null;

  const expiries = routes
    .filter((r) => r.kind === "node")
    .map((r) => repos.breakers.get(`node:${r.node.id}`))
    .filter((b) => b && b.openUntil)
    .map((b) => Date.parse(b.openUntil))
    .filter((t) => Number.isFinite(t));
  const retryAfterMs = candidates.length === 0
    ? (expiries.length ? Math.max(0, Math.max(...expiries) - Date.now()) : null)
    : null;

  return { ordered, routes, candidates, combo, budget, retryAfterMs };
}

/**
 * The 503 for a request with nothing to dispatch to. Combo members get the detail the strategy
 * produced (what was skipped and why); a single route says so plainly.
 */
export function unavailableResponse(res, { route, plan }) {
  const single = route.kind === "node" ? route.node : null;
  let detail;
  if (plan.combo) {
    detail = `every member of combo "${plan.combo.name}" is unavailable${plan.combo.skipped.length ? ` (${plan.combo.skipped.map((s) => `${s.model}: ${s.why}`).join("; ")})` : ""}`;
  } else if (route.kind === "combo") {
    detail = `every member of combo "${route.name}" is out of budget`;
  } else if (single && !single.enabled) {
    // Spelled out separately: "all routes have open breakers" for a node the user disabled
    // themselves sends them looking for a failure that is not there.
    detail = `provider ${single.prefix} is disabled`;
  } else {
    detail = "all routes have open breakers";
  }
  return json(res, 503, { error: { message: "all_unavailable", detail, retryAfterMs: plan.retryAfterMs ?? null } });
}

/**
 * The 503 for a node whose keys cannot serve: none configured at all, or every one cooling down.
 * The two are different situations and saying the wrong one sends the user looking for a key that
 * is already there — the distinction the chat handler makes, kept in one place for every kind.
 */
export function noKeysResponse(res, repos, node) {
  const all = repos.connections.list(node.id);
  const recovery = earliestRecovery(repos, all);
  const retryAfterMs = recovery ? Math.max(0, recovery - Date.now()) : null;
  if (all.length === 0) {
    return json(res, 503, { error: { message: "no_credentials", detail: `no active connection for node ${node.prefix}` } });
  }
  return json(res, 503, {
    error: {
      message: "all_keys_unavailable",
      detail: `every key on ${node.prefix} is cooling down${recovery ? ` — earliest recovers in ${Math.ceil(retryAfterMs / 1000)}s` : ""}`,
      retryAfterMs,
    },
  });
}

/** The combo fields a log line needs, or null when the request was not a combo. */
export function comboInfoFor(combo, node, model, idx) {
  if (!combo) return null;
  const member = model ? `${node.prefix}/${model}` : node.prefix;
  return {
    name: combo.name,
    strategy: combo.strategy,
    member,
    attempt: idx + 1,
    of: combo.of,
    order: combo.order,
    skipped: combo.skipped,
  };
}

/** The console tag for a kind: `IMAGE`, `TTS`, … chat logs its own lines under `REQ`. */
function kindTag(kind) {
  return MEDIA_KINDS[kind]?.logTag ?? "MEDIA";
}

/**
 * What the request and response were, for the console's detail view.
 * Details must never break the proxy — they are diagnostics, not the product.
 */
export function saveMediaDetail(repos, { usageEventId = null, request, response, truncated = false }) {
  try {
    if (request !== undefined) repos.requestDetails.save({ usageEventId, kind: "request", content: { body: request } });
    if (typeof response === "string" && response.length > 0) {
      repos.requestDetails.save({ usageEventId, kind: "response", content: response, truncated });
    }
  } catch { /* details must never break the proxy */ }
}

/* ── combo dispatch, shared by chat and the media handlers ──────────────────────── */

// Per-combo dispatch cursor (RAM; a restart merely restarts the cycle). Only the
// strategies that rotate consult it, so switching a combo to `fastest` and back does
// not leave the rotation mid-cycle.
const comboCursor = new Map();

/**
 * Which turn of the rotation this request is.
 *   round-robin — advances every request
 *   sticky      — advances every `stickyLimit` requests, so a conversation keeps
 *                 hitting the same member (prompt-cache affinity) before moving on
 * Every other strategy ignores the cursor and keeps declared/ranked order.
 */
export function comboTurn(comboName, strategy, stickyLimit = 1) {
  if (strategy !== "round-robin" && strategy !== "sticky") return 0;
  const n = comboCursor.get(comboName) ?? 0;
  comboCursor.set(comboName, n + 1);
  return strategy === "sticky" ? Math.floor(n / Math.max(1, stickyLimit || 1)) : n;
}


/**
 * What a combo request is about to do, for the log.
 *
 * The strategy is the load-bearing field: with `fallback` the first member carrying every
 * request is correct behaviour, with `round-robin` it is a bug — and nothing else in the log
 * distinguishes the two. `skipped` is the other half: a member with an open breaker or one
 * dropped by the budget ceiling would otherwise vanish from the story entirely.
 */
export function describeCombo(repos, route, ordered, routes, candidates) {
  const now = Date.now();
  const nameOf = (r) => `${r.node.prefix}/${r.model}`;
  const serving = new Set(candidates);
  const inFlight = new Set(routes);

  const skipped = [];
  for (const r of ordered) {
    if (r.kind !== "node" || serving.has(r)) continue;
    if (!inFlight.has(r)) {
      skipped.push({ model: nameOf(r), why: "daily budget ceiling reached" });
      continue;
    }
    const open = repos.breakers.get(`node:${r.node.id}`);
    const until = open?.openUntil ? Date.parse(open.openUntil) : NaN;
    skipped.push({
      model: nameOf(r),
      why: Number.isFinite(until) && until > now ? `breaker open until ${new Date(until).toISOString()}` : "unhealthy",
    });
  }

  const order = candidates.map(nameOf);
  const sticky = route.strategy === "sticky" ? ` (${route.stickyLimit ?? 1} per member)` : "";
  const skippedText = skipped.length ? ` · skipped: ${skipped.map((s) => `${s.model} (${s.why})`).join(", ")}` : "";
  return {
    name: route.name,
    strategy: route.strategy,
    stickyLimit: route.stickyLimit ?? 1,
    of: order.length,
    order,
    skipped,
    line: `${route.name} · ${route.strategy}${sticky} · ${order.length} member(s): ${order.join(", ")}${skippedText}`,
  };
}

