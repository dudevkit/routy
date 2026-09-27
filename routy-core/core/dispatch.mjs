// Dispatch policy shared by every kind: which key serves a request, and what a failure is
// allowed to cost a node.
//
// These lived inside the chat handler because chat was the only endpoint. They are not chat
// policy — they are the gateway's policy, and a media request must obey the same rules rather
// than grow a second, subtly different copy of them. (The copy is always where the bug is: a
// rotation that skips a cooling key in one handler and not the other is invisible until a
// provider is failing.)
import { classifyConnectionError, recordConnectionFailure, connectionState, isConnectionAvailable } from "./key-health.mjs";
import { FAILURE_THRESHOLD, OPEN_MS, MAX_OPEN_MS, UPSTREAM_429_MEMO_MS } from "./limits.mjs";
import { maskKey } from "../lib/mask.mjs";
import { costOf } from "./pricing.mjs";
import { addSpend } from "./budget.mjs";
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
export function recordMediaUsage(repos, log, { route, connection, clientModel, kind, status, usage = {}, durationMs, apiKeyId = null, pool = null, attempts = 1 }) {
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

  log.info(kindTag(kind), `${route.node.prefix} ← ${status}`, {
    requestId: event.id,
    kind,
    model: clientModel,
    nodeId: route.node.id,
    connectionId: connection.id,
    key: `${connection.name} (${maskKey(connection.credentials?.apiKey)})`,
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
