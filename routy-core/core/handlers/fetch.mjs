// routy web fetch — kind `webFetch`: the client names a URL, a provider reads it.
//
// This is the only kind where the CALLER chooses the target, which is why the URL is checked
// before anything else happens: scheme, local names, private literals and a private answer from
// DNS, with no allow-list. The reference implementation draws the same line (`assertPublicUrl`
// for client-supplied URLs, the operator's own base URL trusted as-is), and the consequence is
// deliberate rather than incidental: a key is not a person, and keys get embedded in tools other
// people operate. An operator who needs to fetch an internal page points their provider at it —
// routy does not become a general-purpose internal network client.
import { readBody, json } from "../../lib/router.mjs";
import { extractBearer } from "../../lib/auth.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute } from "../routing.mjs";
import { comboInfoFor, dispatchPlan, noKeysResponse, pickConnections, recent429For, recordFailure, recordSuccess, recordMediaUsage, saveMediaDetail, settleFailure, unavailableResponse } from "../dispatch.mjs";
import { recordConnectionSuccess } from "../key-health.mjs";
import { resolveNodeProxy } from "../proxy.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { mediaConfigOf, mediaKindsOf, mediaUrlFor, authStyleFor } from "../media.mjs";
import { buildUpstreamRequest, headersFor, normalizeFetch } from "../mediaMap.mjs";
import { checkUrl } from "../safeFetch.mjs";

const KIND = "webFetch";
const FETCH_TIMEOUT_MS = 60_000;
const FORMATS = new Set(["markdown", "text", "html"]);

export function createFetchHandler(repos, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const log = rootLog;
  const global429Memo = new Map();

  return async function handleFetch(req, res) {
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

    const { model, url: targetUrl, format, max_characters: maxCharacters } = body ?? {};
    if (typeof model !== "string" || model.length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "model required" } });
    }
    if (typeof targetUrl !== "string" || targetUrl.trim().length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "url required" } });
    }
    if (format !== undefined && !FORMATS.has(format)) {
      return json(res, 400, { error: { message: "bad_request", detail: `format must be one of: ${[...FORMATS].join(", ")}` } });
    }
    if (maxCharacters !== undefined && (!Number.isFinite(maxCharacters) || maxCharacters < 0)) {
      return json(res, 400, { error: { message: "bad_request", detail: "max_characters must be a number of characters (0 = no limit)" } });
    }

    // The target is checked before any provider is chosen: a refused URL must not depend on
    // which provider would have been asked, and the answer must name the reason.
    const checker = await checkUrl(targetUrl);
    if (!checker.ok) {
      log.warn("FETCH", `refused a target URL: ${checker.reason}`, { url: targetUrl.slice(0, 200) });
      return json(res, 400, { error: { message: "url_refused", detail: checker.reason, url: targetUrl } });
    }

    const route = resolveRoute(repos, model, { kind: KIND });
    if (!route) {
      const prefix = model.split("/")[0];
      const node = repos.nodes.byPrefix(prefix);
      const detail = node && !mediaKindsOf(node).includes(KIND)
        ? `provider '${prefix}' does not serve web fetch — declare the webFetch kind on the node`
        : `"${model}" is not routable for web fetch — check the prefix, or that the node declares the kind`;
      return json(res, 400, { error: { message: "bad_request", detail } });
    }

    // Media does not consult the daily budget (dispatchPlan's applyBudget), for the same reason
    // search does not: the limit is chat's token spend.
    const plan = dispatchPlan(repos, route, { settings, applyBudget: false });
    const { candidates, combo } = plan;

    if (candidates.length === 0) {
      if (combo) log.warn("FETCH", `${combo.name} ← all ${combo.of} member(s) unavailable`, { ...combo, retryAfterMs: plan.retryAfterMs });
      return unavailableResponse(res, { route, plan });
    }
    if (combo) {
      log.info("FETCH", combo.line, { combo: combo.name, strategy: combo.strategy, stickyLimit: combo.stickyLimit, order: combo.order, skipped: combo.skipped });
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

      if (!map || !baseUrl) {
        const why = !baseUrl ? `no URL for ${KIND}` : `no ${KIND} mapping`;
        if (candidates.length === 1) {
          return json(res, 400, {
            error: {
              message: "bad_request",
              detail: `provider '${node.prefix}' has ${why} — set media.urls.${KIND} and media.map.${KIND} on the node (a fetch provider's request shape is configuration)`,
            },
          });
        }
        log.warn("FETCH", `member ${node.prefix} skipped: ${why}`);
        lastError = { ok: false, status: 400, errorCode: "not_configured", message: `${node.prefix}: ${why}` };
        continue;
      }

      const memoKey = `${node.id}|${r.model ?? node.prefix}`;
      const saturatedUntil = global429Memo.get(memoKey);
      if (saturatedUntil && Date.now() < saturatedUntil) {
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
          bodyText: built.body,
          method: built.method,
          headers: headersFor(map),
        });

        if (!result.ok) {
          lastError = result;
          const settled = settleFailure(repos, {
            node, connection, result, settings,
            recent429: recent429For(recent429, node.id), cooledHere, tag: "FETCH", log,
          });
          if (settled.action === "aborted") {
            return json(res, 499, { error: { message: "client_aborted", detail: "client aborted the request" } });
          }
          if (settled.action === "proxy") {
            if (settled.providerLevel) break;
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
            if (candidates.length > 1) continue;
            return json(res, 429, {
              error: {
                message: "upstream_rate_limited",
                detail: `provider ${node.prefix} is rate-limiting this model for everyone${settled.others ? ` (429 across ${settled.others} keys)` : ""} — not a key problem`,
                retryAfterMs: settled.retryAfterMs,
              },
            });
          }
          if (settled.action === "node") break;
          continue;
        }

        const text = await result.response.text().catch(() => "");
        // A `response.text` provider answers with the page itself (Jina Reader), so the body here
        // is the payload rather than a JSON envelope that failed to parse.
        const parsed = map.response?.text ? text : safeJson(text);
        if (parsed === null) {
          lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "provider returned a non-JSON body" };
          recordFailure(repos, node, lastError);
          log.warn("FETCH", `node ${node.prefix}: non-JSON fetch response`);
          continue;
        }

        recordConnectionSuccess(repos, connection.id);
        recordSuccess(repos, node);
        const normalized = normalizeFetch(parsed, {
          map,
          provider: node.prefix,
          requestedUrl: targetUrl,
          format: format ?? "markdown",
          maxCharacters,
          responseTimeMs: Date.now() - t0,
          upstreamMs: Date.now() - upstreamStarted,
        });
        const usageEventId = recordMediaUsage(repos, log, {
          route: { node }, connection, clientModel: model, kind: KIND, status: "ok",
          usage: {},
          durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
          combo: comboInfoFor(combo, node, r.model, idx),
        });
        saveMediaDetail(repos, { usageEventId, request: { ...body }, response: JSON.stringify(normalized) });
        return json(res, 200, normalized);
      }
    }

    const detail = lastError
      ? `nothing served the request: ${lastError.errorCode} ${lastError.status ?? ""} — ${String(lastError.message || "").slice(0, 200)}`.replace(/\s+/g, " ")
      : "no usable route for this fetch";
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
