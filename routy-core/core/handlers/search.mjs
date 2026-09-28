// routy web search — kind `webSearch`, one normalized shape over providers that share none.
//
// Two things separate this from the earlier media kinds:
//   · the provider call is built from a MAPPING (core/mediaMap.mjs) rather than a fixed path —
//     there is no OpenAI shape for search to fall back on, so a node without a mapping is
//     refused by name instead of guessed at;
//   · combos are allowed (and are why `dispatchPlan` exists here): `search-combo` is part of the
//     contract, and a second member is exactly what a per-provider quota needs.
//
// The SSRF surface is absent by design: routy never fetches the search target, it asks a provider
// to. Web FETCH is the kind where the client names a URL, and that handler validates it.
import { readBody, json } from "../../lib/router.mjs";
import { extractBearer } from "../../lib/auth.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute } from "../routing.mjs";
import { comboInfoFor, dispatchPlan, noKeysResponse, pickConnections, recent429For, recordFailure, recordSuccess, recordMediaUsage, saveMediaDetail, settleFailure, unavailableResponse } from "../dispatch.mjs";
import { recordConnectionSuccess } from "../key-health.mjs";
import { resolveNodeProxy } from "../proxy.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { mediaConfigOf, mediaKindsOf, mediaUrlFor, authStyleFor } from "../media.mjs";
import { buildUpstreamRequest, headersFor, normalizeSearch } from "../mediaMap.mjs";

const KIND = "webSearch";
const SEARCH_TIMEOUT_MS = 30_000;

export function createSearchHandler(repos, { timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const log = rootLog;
  const global429Memo = new Map(); // node|model -> until, same window as chat (limits.mjs)

  return async function handleSearch(req, res) {
    const t0 = Date.now();
    const settings = repos.settings.all();
    let apiKeyId = null;
    if (settings.requireApiKey !== false) {
      const token = extractBearer(req);
      const key = token ? repos.apiKeys.verify(token) : null;
      if (!key) return json(res, 401, { error: { message: "auth_error", detail: "valid API key required" } });
      apiKeyId = key.id;
    }

    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      return json(res, 400, { error: { message: "bad_request", detail: "invalid JSON body" } });
    }

    const { model, query } = body ?? {};
    if (typeof model !== "string" || model.length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "model required" } });
    }
    if (typeof query !== "string" || query.trim().length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "query must be a non-empty string" } });
    }

    const route = resolveRoute(repos, model, { kind: KIND });
    if (!route) {
      const prefix = model.split("/")[0];
      const node = repos.nodes.byPrefix(prefix);
      const detail = node && !mediaKindsOf(node).includes(KIND)
        ? `provider '${prefix}' does not serve web search — declare the webSearch kind on the node`
        : `"${model}" is not routable for web search — check the prefix, or that the node declares the kind`;
      return json(res, 400, { error: { message: "bad_request", detail } });
    }

    // Media does not consult the daily budget (dispatchPlan's applyBudget): that limit is chat's
    // token spend, and a web request has no price in routy to weigh against it.
    const plan = dispatchPlan(repos, route, { settings, applyBudget: false });
    const { candidates, combo } = plan;

    if (candidates.length === 0) {
      if (combo) log.warn("SEARCH", `${combo.name} ← all ${combo.of} member(s) unavailable`, { ...combo, retryAfterMs: plan.retryAfterMs });
      return unavailableResponse(res, { route, plan });
    }
    if (combo) {
      log.info("SEARCH", combo.line, { combo: combo.name, strategy: combo.strategy, stickyLimit: combo.stickyLimit, order: combo.order, skipped: combo.skipped });
    }

    const clientGone = new AbortController();
    res.on("close", () => clientGone.abort());
    const signal = timeoutMs > 0
      ? AbortSignal.any([clientGone.signal, AbortSignal.timeout(timeoutMs)])
      : clientGone.signal;

    const recent429 = new Map();
    const cooledHere = [];
    let lastError = null;
    let attempts = 0;

    for (const [idx, r] of candidates.entries()) {
      const node = r.node;
      const map = mediaConfigOf(node).map?.[KIND];
      const baseUrl = mediaUrlFor(node, KIND);

      // The web kinds have no derivable endpoint and no assumed wire format, so a missing URL or
      // mapping is a configuration error, not a case to fall through on.
      if (!map || !baseUrl) {
        const why = !baseUrl ? `no URL for ${KIND}` : `no ${KIND} mapping`;
        if (candidates.length === 1) {
          return json(res, 400, {
            error: {
              message: "bad_request",
              detail: `provider '${node.prefix}' has ${why} — set media.urls.${KIND} and media.map.${KIND} on the node (the provider's request/response shapes are configuration, not convention)`,
            },
          });
        }
        log.warn("SEARCH", `member ${node.prefix} skipped: ${why}`);
        lastError = { ok: false, status: 400, errorCode: "not_configured", message: `${node.prefix}: ${why}` };
        continue;
      }

      const memoKey = `${node.id}|${r.model ?? node.prefix}`;
      const saturatedUntil = global429Memo.get(memoKey);
      if (saturatedUntil && Date.now() < saturatedUntil) {
        // A member already proven provider-wide saturated is skipped rather than failing the
        // request: the memo exists to stop re-probing, and another member can still serve it.
        lastError = {
          ok: false, status: 429, errorCode: "upstream_rate_limited",
          message: `provider ${node.prefix} is rate-limiting this model for everyone`,
          retryAfterMs: saturatedUntil - Date.now(),
        };
        continue;
      }

      const keys = pickConnections(repos, node);
      if (keys.length === 0) {
        if (candidates.length === 1) return noKeysResponse(res, repos, node);
        lastError = { ok: false, status: 503, errorCode: "no_credentials", message: `no usable key on ${node.prefix}` };
        continue;
      }

      const style = authStyleFor(node, KIND);
      for (const connection of keys) {
        attempts++;
        const proxy = resolveNodeProxy(repos, node, connection, { settings });
        const secret = connection.credentials?.apiKey || connection.credentials?.accessToken || null;
        const built = buildUpstreamRequest({ baseUrl, body, map, secret });
        const upstreamStarted = Date.now();

        const executor = new DefaultExecutor(node, connection, { proxy });
        const result = await executor.execute({
          model: r.model ?? null,
          stream: undefined,
          signal,
          log,
          url: built.url,
          auth: { style, secret, header: map.authHeader ?? null },
          bodyText: built.body,             // exactly what the mapping built — nothing is added
          method: built.method,
          headers: headersFor(map),         // the mapping's static headers (never authorization)
        });

        if (!result.ok) {
          lastError = result;
          const settled = settleFailure(repos, {
            node, connection, result, settings,
            recent429: recent429For(recent429, node.id), cooledHere, tag: "SEARCH", log,
          });
          if (settled.action === "aborted") {
            return json(res, 499, { error: { message: "client_aborted", detail: "client aborted the request" } });
          }
          if (settled.action === "proxy") {
            if (settled.providerLevel) break; // provider-level binding: another member may not share it
            continue;
          }
          if (settled.action === "client") {
            const rejectedId = recordMediaUsage(repos, log, {
              route: { node }, connection, clientModel: model, kind: KIND, status: "rejected",
              durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
              combo: comboInfoFor(combo, node, r.model, idx),
            });
            saveMediaDetail(repos, { usageEventId: rejectedId, request: { ...body } });
            return json(res, result.status || 400, { error: { message: "upstream_rejected", detail: String(result.message || "provider rejected the request") } });
          }
          if (settled.action === "global") {
            global429Memo.set(memoKey, settled.until);
            // Another member is a different provider and still entitled to try.
            if (candidates.length > 1) continue;
            return json(res, 429, {
              error: {
                message: "upstream_rate_limited",
                detail: `provider ${node.prefix} is rate-limiting this model for everyone${settled.others ? ` (429 across ${settled.others} keys)` : ""} — not a key problem`,
                retryAfterMs: settled.retryAfterMs,
              },
            });
          }
          if (settled.action === "node") break; // this member's fault: try the next member
          continue;                             // this key's fault: try the next key
        }

        const text = await result.response.text().catch(() => "");
        const parsed = safeJson(text);
        if (parsed === null) {
          lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "provider returned a non-JSON body" };
          recordFailure(repos, node, lastError);
          log.warn("SEARCH", `node ${node.prefix}: non-JSON search response`);
          continue;
        }

        recordConnectionSuccess(repos, connection.id);
        recordSuccess(repos, node);
        const normalized = normalizeSearch(parsed, {
          map,
          provider: node.prefix,
          query,
          responseTimeMs: Date.now() - t0,
          upstreamMs: Date.now() - upstreamStarted,
        });
        const usageEventId = recordMediaUsage(repos, log, {
          route: { node }, connection, clientModel: model, kind: KIND, status: "ok",
          usage: {}, // search is charged per call, not per token; the provider's own cost is in the response
          durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
          combo: comboInfoFor(combo, node, r.model, idx),
        });
        saveMediaDetail(repos, { usageEventId, request: { ...body }, response: JSON.stringify(normalized) });
        return json(res, 200, normalized);
      }
    }

    // Nothing served: report the last thing that went wrong, naming the member when there were
    // several so the console can tell which one to look at.
    const detail = lastError
      ? `nothing served the request: ${lastError.errorCode} ${lastError.status ?? ""} — ${String(lastError.message || "").slice(0, 200)}`.replace(/\s+/g, " ")
      : "no usable route for this search";
    const status = lastError?.status && lastError.status >= 400 && lastError.status < 600 && lastError.status !== 499
      ? lastError.status
      : 502;
    return json(res, status, {
      error: { message: lastError?.errorCode === "upstream_rate_limited" ? "upstream_rate_limited" : "all_routes_failed", detail, retryAfterMs: lastError?.retryAfterMs ?? undefined },
    });
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
