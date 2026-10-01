// routy System One — kind `systemone`: a situation in, a set of typed answers out.
//
// The one media kind whose upstream body routy does NOT build from a mapping, and the exception
// is principled rather than convenient: here the provider's request shape IS the client's request
// shape. 9Router forwards the caller's `{ state, questions }` unchanged and overrides only the
// model id (its `POST /api/v1/systemone` handler: `{ ...body, model }`), and the answer —
// `{ model, answers, usage }` — is the same document both ends already agree on. A mapping that
// renamed `state` to `state` would be a config with exactly one possible value, which is why the
// reference implementation does not have one either. `questions` is caller-authored all the way
// down (each entry is its own `{ type, instructions }`), so routy cannot meaningfully validate the
// inside of it and does not pretend to: it checks the shape the upstream would 500 on, and
// forwards the rest.
//
// What routy does add around the call is what the reference adds:
//   · the `x-opencode-session` header the OpenCode Zen upstream is addressed with — generated per
//     request, in the shape the provider's own clients use (`ses_` + 12 hex + 14 base62). The
//     upstream answers without it (verified live), so it is parity and per-request identity
//     rather than a gate;
//   · the usage mapping, because the provider reports `input_tokens`/`output_tokens` while
//     routy's own accounting reads `promptTokens`/`completionTokens`. Translating here is what
//     makes a System One call show a real token count in the console instead of an empty one.
//
// Everything else — which endpoint, which credential, which network exit, which combo member,
// which breaker — is the same machinery every other kind runs on.
import crypto from "node:crypto";
import { readBody, json } from "../../lib/router.mjs";
import { extractBearer } from "../../lib/auth.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute } from "../routing.mjs";
import { comboInfoFor, dispatchPlan, noKeysResponse, pickConnections, recent429For, recordFailure, recordSuccess, recordMediaUsage, saveMediaDetail, settleFailure, unavailableResponse } from "../dispatch.mjs";
import { recordConnectionSuccess } from "../key-health.mjs";
import { resolveNodeProxy } from "../proxy.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { mediaConfigOf, mediaKindsOf, mediaUrlFor, authStyleFor } from "../media.mjs";
import { headersFor } from "../mediaMap.mjs";

const KIND = "systemone";
const SYSTEMONE_TIMEOUT_MS = 60_000;

// The same alphabet the reference picks its session suffix from. Base62 over a byte biases the
// first four characters slightly; that is the reference's behaviour and a session id is not a
// secret, so the shape is what matters.
const SESSION_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A per-request upstream session id: `ses_` + 12 hex + 14 base62.
 *
 * Exported because the format is a claim about the provider, and a claim that is only written in
 * a header string is one nobody can test.
 */
export function systemoneSessionId() {
  const hex = crypto.randomBytes(6).toString("hex");
  const bytes = crypto.randomBytes(14);
  let tail = "";
  for (const byte of bytes) tail += SESSION_ALPHABET[byte % SESSION_ALPHABET.length];
  return `ses_${hex}${tail}`;
}

export function createSystemoneHandler(repos, { timeoutMs = SYSTEMONE_TIMEOUT_MS } = {}) {
  const log = rootLog;
  const global429Memo = new Map(); // node|model -> until, same window as chat (limits.mjs)

  return async function handleSystemone(req, res) {
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

    const { model, state, questions } = body ?? {};
    if (typeof model !== "string" || model.length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "model required" } });
    }
    // The two fields the reference checks, checked the same way and no further. `state` is
    // opaque — the provider decides what a situation may be — so "present and not null" is the
    // whole of routy's business with it. An upstream asked without it answers 500 "endpoint is
    // unavailable" (verified), which is exactly the kind of misleading error a 400 here prevents.
    if (state === undefined || state === null) {
      return json(res, 400, { error: { message: "bad_request", detail: "missing required field: state" } });
    }
    // `questions` must be an object and not an array: each key is a question name the caller will
    // find again in `answers`, so a list would answer under indices nobody asked for.
    if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
      return json(res, 400, { error: { message: "bad_request", detail: "missing required field: questions (an object of name → { type, instructions })" } });
    }

    const route = resolveRoute(repos, model, { kind: KIND });
    if (!route) {
      const prefix = model.split("/")[0];
      const node = repos.nodes.byPrefix(prefix);
      // The message names what WOULD work: a wrong prefix is the common case (an id typed with
      // a backslash, or a remembered short name), and "check the prefix" leaves the caller
      // guessing which prefix is the right one.
      const serving = repos.nodes.list().filter((n) => mediaKindsOf(n).includes(KIND)).map((n) => n.prefix);
      const detail = node && !mediaKindsOf(node).includes(KIND)
        ? `provider '${prefix}' does not serve System One — declare the systemone kind on the node`
        : `"${model}" is not routable for System One — ${serving.length ? `nodes that serve it: ${serving.join(", ")} (model id = <prefix>/<model>)` : "no node declares the kind yet — add one from the Media screen"}`;
      return json(res, 400, { error: { message: "bad_request", detail } });
    }

    // Media does not consult the daily budget: that limit is chat's token spend.
    const plan = dispatchPlan(repos, route, { settings, applyBudget: false });
    const { candidates, combo } = plan;

    if (candidates.length === 0) {
      if (combo) log.warn("SYSTEMONE", `${combo.name} ← all ${combo.of} member(s) unavailable`, { ...combo, retryAfterMs: plan.retryAfterMs });
      return unavailableResponse(res, { route, plan });
    }
    if (combo) {
      log.info("SYSTEMONE", combo.line, { combo: combo.name, strategy: combo.strategy, stickyLimit: combo.stickyLimit, order: combo.order, skipped: combo.skipped });
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
      const baseUrl = mediaUrlFor(node, KIND);

      // No mapping to require — the wire format is the configured endpoint itself — so a missing
      // URL is the only configuration error this kind can have.
      if (!baseUrl) {
        if (candidates.length === 1) {
          return json(res, 400, {
            error: {
              message: "bad_request",
              detail: `provider '${node.prefix}' has no URL for ${KIND} — set media.urls.${KIND} on the node (the upstream endpoint is not derivable from a chat base)`,
            },
          });
        }
        log.warn("SYSTEMONE", `member ${node.prefix} skipped: no URL for ${KIND}`);
        lastError = { ok: false, status: 400, errorCode: "not_configured", message: `${node.prefix}: no URL for ${KIND}` };
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
        // The upstream is called with the provider's OWN model id, not routy's prefixed one:
        // `opencode/jev-1.13-free` reaches Zen as `jev-1.13-free`. `r.model` is that bare id —
        // and for a provider whose ids are namespaced themselves (OpenRouter's
        // `typesafe/jev-1.13`) it is the whole id, because the prefix stripped was routy's.
        const upstreamModel = r.model ?? model;
        // `{}` when the node carries no mapping: this kind needs none, so a missing one is the
        // normal case rather than a config error (`headersFor` reads `map.headers`, so passing
        // undefined here would be a type error at the worst possible moment).
        const sessionHeaders = {
          ...headersFor(mediaConfigOf(node).map?.[KIND] ?? {}),
          "x-opencode-session": systemoneSessionId(),
        };
        const upstreamStarted = Date.now();

        const executor = new DefaultExecutor(node, connection, { proxy });
        const result = await executor.execute({
          model: upstreamModel,
          stream: undefined,
          signal,
          log,
          url: baseUrl,
          auth: { style, secret, header: null },
          bodyText: JSON.stringify({ ...body, model: upstreamModel }),
          method: "POST",
          headers: sessionHeaders,
        });

        if (!result.ok) {
          lastError = result;
          const settled = settleFailure(repos, {
            node, connection, result, settings,
            recent429: recent429For(recent429, node.id), cooledHere, tag: "SYSTEMONE", log,
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
          log.warn("SYSTEMONE", `node ${node.prefix}: non-JSON System One response`);
          continue;
        }

        recordConnectionSuccess(repos, connection.id);
        recordSuccess(repos, node);
        // The provider's answer is returned untouched — it is a schema both ends already share,
        // and wrapping or renaming it would be routy inventing a dialect. The token counts are
        // read out of it for routy's own accounting, which is the one place the two vocabularies
        // meet (provider `input_tokens`/`output_tokens` → routy `promptTokens`/`completionTokens`).
        const usage = {
          promptTokens: numberOrNull(parsed?.usage?.input_tokens),
          completionTokens: numberOrNull(parsed?.usage?.output_tokens),
        };
        const usageEventId = recordMediaUsage(repos, log, {
          route: { node }, connection, clientModel: model, kind: KIND, status: "ok",
          usage,
          durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
          combo: comboInfoFor(combo, node, r.model, idx),
        });
        saveMediaDetail(repos, { usageEventId, request: { ...body }, response: JSON.stringify(parsed) });
        return json(res, 200, parsed);
      }
    }

    const detail = lastError
      ? `nothing served the request: ${lastError.errorCode} ${lastError.status ?? ""} — ${String(lastError.message || "").slice(0, 200)}`.replace(/\s+/g, " ")
      : "no usable route for this System One request";
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

/** Usage fields are the provider's; a provider that omits one leaves routy's column empty. */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
