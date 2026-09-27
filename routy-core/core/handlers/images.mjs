// routy image generation — kind `image`, uniform OpenAI shape.
//
// Same spine as embeddings (resolve by kind → keys in dispatch order → executor → the shared
// failure settlement), plus the one thing images have: a response that may arrive as a URL
// rather than as JSON the client can hold. `?response_format` at the edge decides what the
// client gets; `binary` is the mode that makes routy dereference a URL a provider chose, which
// is why that path goes through core/safeFetch.mjs and nothing else does.
//
// Deferred with the rest of the bespoke adapters (docs/media-providers.md §3): async
// submit+poll providers, SSE (codex), and every provider whose param mapping needs code
// (`size` → aspect_ratio, `n` → num_images).
import { readBody, json } from "../../lib/router.mjs";
import { extractBearer } from "../../lib/auth.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute } from "../routing.mjs";
import { pickConnections, recent429For, recordFailure, recordSuccess, recordMediaUsage, saveMediaDetail, settleFailure } from "../dispatch.mjs";
import { recordConnectionSuccess, earliestRecovery } from "../key-health.mjs";
import { resolveNodeProxy } from "../proxy.mjs";
import { budgetState } from "../budget.mjs";
import { isMetered } from "../pricing.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { mediaUrlFor, authStyleFor, mediaKindsOf } from "../media.mjs";
import { safeFetch, looksLikeImage } from "../safeFetch.mjs";

const KIND = "image";
const IMAGE_TIMEOUT_MS = 60_000;
// Bytes a binary response may cost. Images are MiB; a "32 MiB image" is an attack or a
// mistake, and either way is not something to buffer silently.
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const RESPONSE_MODES = new Set(["url", "b64_json", "binary"]);

function upstreamUrl(node) {
  const explicit = mediaUrlFor(node, KIND);
  if (explicit) return explicit;
  return `${node.baseUrl.replace(/\/+$/, "")}/images/generations`;
}

/** Content type from the bytes themselves: the header of a fetched body is attacker-set. */
function imageContentType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf.slice(8, 10).toString("latin1") === "WE") return "image/webp";
  return "image/png";
}

export function createImagesHandler(repos, { timeoutMs = IMAGE_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const log = rootLog;
  const global429Memo = new Map(); // see the same memo in embeddings.mjs

  return async function handleImages(req, res) {
    const t0 = Date.now();
    const settings = repos.settings.all();
    let apiKeyId = null;
    if (settings.requireApiKey !== false) {
      const token = extractBearer(req);
      const key = token ? repos.apiKeys.verify(token) : null;
      if (!key) return json(res, 401, { error: { message: "auth_error", detail: "valid API key required" } });
      apiKeyId = key.id;
    }

    const url = new URL(req.url, "http://localhost");
    const mode = url.searchParams.get("response_format") || "url";
    if (!RESPONSE_MODES.has(mode)) {
      return json(res, 400, { error: { message: "bad_request", detail: `response_format must be one of: ${[...RESPONSE_MODES].join(", ")} (query parameter)` } });
    }

    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      return json(res, 400, { error: { message: "bad_request", detail: "invalid JSON body" } });
    }

    const { model, prompt } = body ?? {};
    if (typeof model !== "string" || model.length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "model required" } });
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "prompt required" } });
    }

    const route = resolveRoute(repos, model, { kind: KIND });
    if (!route) {
      const prefix = model.split("/")[0];
      const node = repos.nodes.byPrefix(prefix);
      const detail = node && !mediaKindsOf(node).includes(KIND)
        ? `provider '${prefix}' does not serve images — declare the image kind on the node`
        : `"${model}" is not routable for images — check the prefix, or that the model exists`;
      return json(res, 400, { error: { message: "bad_request", detail } });
    }
    if (route.kind === "combo") {
      return json(res, 400, { error: { message: "bad_request", detail: `"${route.name}" is a combo — combos for images are not enabled yet` } });
    }
    const node = route.node;
    if (!node.enabled) {
      return json(res, 503, { error: { message: "node_disabled", detail: `${node.prefix} is disabled` } });
    }

    const budget = budgetState(settings.budgetUsdPerDay);
    if (budget.over && isMetered(node)) {
      return json(res, 429, {
        error: { message: "budget_exhausted", detail: "the daily budget is reached and this node bills per request", retryAfterMs: budget.resetInMs ?? null },
      });
    }

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

    const clientGone = new AbortController();
    res.on("close", () => clientGone.abort());
    const signal = timeoutMs > 0
      ? AbortSignal.any([clientGone.signal, AbortSignal.timeout(timeoutMs)])
      : clientGone.signal;

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

    // The client's body, passed through with only the prefix replaced: under the uniform
    // provider rule the upstream speaks the OpenAI shape, so its own fields belong to it. Two
    // delivery instructions are the EDGE's, not the provider's:
    //   ?response_format=binary  → we need bytes, so ask for base64 directly — a provider that
    //       hands us bytes needs no fetch from us at all, and the fetch is the dangerous half;
    //   ?response_format=url|b64_json → the client named its delivery, and that wins over a
    //       field left in the body (the query is later, so it is the one meant).
    // With no query at all, whatever the body said stands, and the provider's default applies.
    const outbound = { ...body, model: route.model };
    const modeParam = url.searchParams.get("response_format");
    if (mode === "binary") outbound.response_format = "b64_json";
    else if (modeParam) outbound.response_format = modeParam;

    const style = authStyleFor(node, KIND);
    const auth = { style, secret: null };
    // A local provider naming its own origin is not an attack; anything else must be public.
    const allowHosts = [new URL(node.baseUrl).hostname];

    let lastError = null;
    let attempts = 0;
    for (const connection of keys) {
      attempts++;
      const proxy = resolveNodeProxy(repos, node, connection, { settings });
      auth.secret = connection.credentials?.apiKey || connection.credentials?.accessToken || null;

      const executor = new DefaultExecutor(node, connection, { proxy });
      const result = await executor.execute({
        model: route.model,
        body: outbound,
        stream: undefined,
        signal,
        log,
        url: upstreamUrl(node),
        auth,
      });

      if (!result.ok) {
        lastError = result;
        const settled = settleFailure(repos, {
          node, connection, result, settings,
          recent429: recent429For(recent429, node.id), cooledHere, tag: "IMAGE", log,
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
        if (settled.action === "node") break;
        continue;
      }

      const text = await result.response.text().catch(() => "");
      const parsed = safeJson(text);
      if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) {
        lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "provider returned no image data" };
        recordFailure(repos, node, lastError);
        log.warn("IMAGE", `node ${node.prefix}: response carries no image data`);
        continue;
      }

      recordConnectionSuccess(repos, connection.id);
      recordSuccess(repos, node);

      let payload = text;
      let contentType = "application/json";
      let filename = null;

      if (mode === "binary") {
        const first = parsed.data[0];
        let bytes = null;
        if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
          // Bytes the provider handed us directly: same trust as the JSON we just read.
          bytes = Buffer.from(first.b64_json, "base64");
          if (bytes.length > maxBytes) {
            lastError = { ok: false, status: 502, errorCode: "upstream_error", message: `image of ${bytes.length} bytes exceeds the ${maxBytes} byte cap` };
            recordFailure(repos, node, lastError);
            log.warn("IMAGE", `node ${node.prefix}: ${lastError.message}`);
            continue;
          }
        } else if (typeof first.url === "string" && first.url.length > 0) {
          // The dangerous path: a URL a provider chose, fetched from inside the gateway.
          // Guarded — and on refusal we say so rather than forwarding a surprise.
          const fetched = await safeFetch(first.url, { maxBytes, allowHosts, expectImage: true, timeoutMs: timeoutMs });
          if (!fetched.ok) {
            lastError = { ok: false, status: 502, errorCode: "image_fetch_failed", message: fetched.reason };
            recordFailure(repos, node, lastError);
            log.warn("IMAGE", `node ${node.prefix}: image fetch refused — ${fetched.reason}`, { url: first.url });
            return json(res, 502, {
              error: {
                message: "image_fetch_failed",
                detail: `the provider returned a URL this gateway would not fetch: ${fetched.reason}`,
                url: first.url,
              },
            });
          }
          bytes = fetched.body;
          contentType = fetched.contentType || imageContentType(bytes);
        } else {
          lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "image entry has neither b64_json nor url" };
          recordFailure(repos, node, lastError);
          log.warn("IMAGE", `node ${node.prefix}: image entry carries neither b64_json nor url`);
          continue;
        }

        if (!looksLikeImage(bytes)) {
          lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "provider returned bytes that are not an image" };
          recordFailure(repos, node, lastError);
          log.warn("IMAGE", `node ${node.prefix}: payload is not an image (${bytes.length} bytes)`);
          continue;
        }

        payload = bytes;
        contentType = imageContentType(bytes);
        const ext = contentType === "image/jpeg" ? "jpg" : contentType.replace("image/", "");
        filename = `image.${ext}`;
      }

      const usageEventId = recordMediaUsage(repos, log, {
        route: { node }, connection, clientModel: model, kind: KIND, status: "ok",
        usage: {}, // images carry no token usage; recording zeros would look like data
        durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
      });
      // The response is the image itself — base64 in a detail row would be megabytes of
      // diagnostics nobody reads, so only JSON responses are stored.
      if (contentType === "application/json") saveMediaDetail(repos, { usageEventId, request: outbound, response: text });

      res.writeHead(200, {
        "content-type": contentType,
        ...(filename ? { "content-disposition": `inline; filename="${filename}"` } : {}),
      });
      res.end(payload);
      return;
    }

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
