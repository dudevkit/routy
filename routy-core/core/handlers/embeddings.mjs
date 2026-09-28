// routy embeddings — kind `embedding`, uniform OpenAI shape.
//
// The template every media handler copies: resolve by kind, pick a key in dispatch order, call
// the provider's OpenAI-shaped endpoint, classify failures the way chat does, record usage
// under the request's kind. The HTTP call goes through DefaultExecutor on purpose — proxy plan,
// exit rotation, address-level classification, retries and connect timeout are all its, so media
// inherits the gateway's egress behaviour instead of growing a second copy of it that drifts.
//
// Where this differs from 9Router: no normalization of the response. Under "all providers
// similar" (docs/media-providers.md §0) the provider must already speak the OpenAI shape, so
// the answer passes through unchanged — `gemini`'s embedContent conversion is deferred with the
// rest of the bespoke adapters.
import { readBody, json } from "../../lib/router.mjs";
import { extractBearer } from "../../lib/auth.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute } from "../routing.mjs";
import { pickConnections, recent429For, recordFailure, recordSuccess, recordMediaUsage, saveMediaDetail, settleFailure , dispatchPlan, unavailableResponse } from "../dispatch.mjs";
import { recordConnectionSuccess, earliestRecovery } from "../key-health.mjs";
import { resolveNodeProxy } from "../proxy.mjs";
import { isMetered } from "../pricing.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { mediaUrlFor, authStyleFor, mediaKindsOf } from "../media.mjs";

const KIND = "embedding";
// Media calls are single bounded round trips (no stream to babysit), so this is the whole
// budget: a provider that accepts the connection and then never answers must not hold the
// client open. The executor's connect timeout covers getting there; this covers getting back.
const EMBEDDINGS_TIMEOUT_MS = 60_000;

/**
 * Where to send it: an explicit per-kind URL when the node has one, else the node's base URL
 * plus the OpenAI path. One rule stated once — an adapter deciding this per provider is how a
 * chat base and an embeddings base drift apart.
 */
function upstreamUrl(node) {
  const explicit = mediaUrlFor(node, KIND);
  if (explicit) return explicit;
  return `${node.baseUrl.replace(/\/+$/, "")}/embeddings`;
}

export function createEmbeddingsHandler(repos, { timeoutMs = EMBEDDINGS_TIMEOUT_MS } = {}) {
  const log = rootLog;
  // A node+model we have already proven provider-wide saturated stays saturated for the window
  // (RAM, per handler): without this every request waits out a 429 round trip to learn what one
  // 429 already said. The window itself is shared with chat — UPSTREAM_429_MEMO_MS in limits.
  const global429Memo = new Map();

  return async function handleEmbeddings(req, res) {
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

    const { model, input } = body ?? {};
    if (typeof model !== "string" || model.length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "model required" } });
    }
    const inputOk = (typeof input === "string" && input.length > 0)
      || (Array.isArray(input) && input.length > 0 && input.every((i) => typeof i === "string"));
    if (!inputOk) {
      return json(res, 400, { error: { message: "bad_request", detail: "input must be a string or a non-empty array of strings" } });
    }

    const route = resolveRoute(repos, model, { kind: KIND });
    if (!route) {
      // Two refusals, and naming the wrong one sends the user hunting for a key that is
      // already there (the same distinction the chat handler makes).
      const prefix = model.split("/")[0];
      const node = repos.nodes.byPrefix(prefix);
      const detail = node && !mediaKindsOf(node).includes(KIND)
        ? `provider '${prefix}' does not serve embeddings — declare the embedding kind on the node`
        : `"${model}" is not routable for embeddings — check the prefix, or that the model exists`;
      return json(res, 400, { error: { message: "bad_request", detail } });
    }
    if (route.kind === "combo") {
      // Combinations for media need the strategy engine wired to kind-scoped members (M4).
      // Refusing plainly beats serving members in declared order while the combo says
      // round-robin — a request that looks compliant but is not.
      return json(res, 400, { error: { message: "bad_request", detail: `"${route.name}" is a combo — combos for embeddings are not enabled yet` } });
    }
    // Availability comes from the same plan chat uses (dispatch.mjs): strategy order, whether the
    // node is enabled, and — the part this handler used to miss — an OPEN BREAKER. A node the
    // dashboard shows as down must not keep answering media requests.
    //
    // The daily budget is deliberately NOT consulted (`applyBudget: false`): it is denominated in
    // chat token spend, and a media request has no price in routy to weigh against it.
    const plan = dispatchPlan(repos, route, { settings, applyBudget: false });
    if (plan.candidates.length === 0) return unavailableResponse(res, { route, plan });
    const node = route.node;

    // Already proven provider-wide saturated for this model: fail fast rather than re-probe.
    const memoKey = `${node.id}|${route.model}`;
    const saturatedUntil = global429Memo.get(memoKey);
    if (saturatedUntil && Date.now() < saturatedUntil) {
      return json(res, 429, {
        error: {
          message: "upstream_rate_limited",
          detail: `provider ${node.prefix} is rate-limiting ${route.model} for everyone — not a key problem`,
          retryAfterMs: saturatedUntil - Date.now(),
        },
      });
    }

    // The client walking away must cancel the upstream call and cost the node nothing.
    const clientGone = new AbortController();
    res.on("close", () => clientGone.abort());
    const signal = timeoutMs > 0
      ? AbortSignal.any([clientGone.signal, AbortSignal.timeout(timeoutMs)])
      : clientGone.signal;

    // Which connection ids 429'd on this request (the behavior that says "provider-wide"),
    // and which this request has cooled — the latter is rolled back if the verdict turns out
    // to be provider-wide, because a limit that hits everyone was never the key's fault.
    const recent429 = new Map();
    const cooledHere = [];

    const keys = pickConnections(repos, node);
    if (keys.length === 0) {
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

    const outbound = {
      model: route.model,
      input,
      ...(body.encoding_format !== undefined ? { encoding_format: body.encoding_format } : {}),
      ...(body.dimensions !== undefined ? { dimensions: body.dimensions } : {}),
    };
    const style = authStyleFor(node, KIND);
    const auth = { style, secret: null };

    let lastError = null;
    let attempts = 0;
    for (const connection of keys) {
      attempts++;
      const proxy = resolveNodeProxy(repos, node, connection, { settings });
      auth.secret = connection.credentials?.apiKey || connection.credentials?.accessToken || null;

      const executor = new DefaultExecutor(node, connection, { proxy });
      const result = await executor.execute({
        model: route.model,
        // `stream: undefined` makes JSON.stringify drop it — embeddings have no stream
        // parameter, and a body this endpoint rejects would be our own bug, not the caller's.
        body: outbound,
        stream: undefined,
        signal,
        log,
        url: upstreamUrl(node),
        auth,
      });

      if (!result.ok) {
        // Settled once, by the shared rule — see dispatch.mjs `settleFailure`.
        lastError = result;
        const settled = settleFailure(repos, {
          node, connection, result, settings,
          recent429: recent429For(recent429, node.id), cooledHere, tag: "EMBED", log,
        });

        if (settled.action === "aborted") {
          return json(res, 499, { error: { message: "client_aborted", detail: "client aborted the request" } });
        }
        if (settled.action === "proxy") {
          // A provider-level binding covers every key of this node, so rotating keys against it
          // only multiplies the failure; a key-level pool's next key may reach a working exit.
          if (settled.providerLevel) break;
          continue;
        }
        if (settled.action === "client") {
          // Reported to the caller, charged to nobody — and recorded, so a rejected request is
          // still visible in the log as something that happened rather than something that
          // did not.
          const rejectedId = recordMediaUsage(repos, log, {
            route: { node }, connection, clientModel: model, kind: KIND, status: "rejected",
            durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
          });
          saveMediaDetail(repos, { usageEventId: rejectedId, request: outbound });
          return json(res, result.status || 400, { error: { message: "upstream_rejected", detail: String(result.message || "provider rejected the request") } });
        }
        if (settled.action === "global") {
          global429Memo.set(memoKey, settled.until);
          return json(res, 429, {
            error: {
              message: "upstream_rate_limited",
              detail: `provider ${node.prefix} is rate-limiting this model for everyone${settled.others ? ` (429 across ${settled.others} keys)` : ""} — not a key problem`,
              retryAfterMs: settled.retryAfterMs,
            },
          });
        }
        if (settled.action === "node") break; // the node's fault: rotating keys multiplies load
        continue;                             // the key's problem: the next key may serve it
      }

      const text = await result.response.text().catch(() => "");
      const parsed = safeJson(text);
      if (!parsed) {
        lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "provider returned a non-JSON body" };
        recordFailure(repos, node, lastError);
        log.warn("EMBED", `node ${node.prefix}: non-JSON response for an embeddings request`);
        continue;
      }

      recordConnectionSuccess(repos, connection.id);
      recordSuccess(repos, node);
      const usage = {
        promptTokens: parsed?.usage?.prompt_tokens ?? null,
        // OpenAI reports both prompt_tokens and total_tokens; where only one exists, storing it
        // as completion tokens would describe a completion this API never returns, so the pair
        // is recorded exactly as the provider framed it.
        completionTokens: parsed?.usage?.total_tokens ?? null,
      };
      const usageEventId = recordMediaUsage(repos, log, {
        route: { node }, connection, clientModel: model, kind: KIND, status: "ok", usage,
        durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
      });
      saveMediaDetail(repos, { usageEventId, request: outbound, response: text });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(text);
      return;
    }

    // Every key failed: say what the last one did, and when one recovers if it is cooling down.
    const recovery = earliestRecovery(repos, keys);
    const retryAfterMs = recovery ? Math.max(0, recovery - Date.now()) : null;
    const detail = lastError
      ? `every key on ${node.prefix} failed: ${lastError.errorCode} ${lastError.status ?? ""} — ${String(lastError.message || "").slice(0, 200)}`.replace(/\s+/g, " ")
      : `no usable key on ${node.prefix}`;
    const status = lastError?.status && lastError.status >= 400 && lastError.status < 600 && lastError.status !== 499
      ? lastError.status
      : 502;
    return json(res, status, { error: { message: "all_keys_failed", detail, retryAfterMs: retryAfterMs ?? undefined } });
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
