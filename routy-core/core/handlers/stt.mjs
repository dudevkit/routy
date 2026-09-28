// routy speech-to-text — kind `stt`, uniform OpenAI shape (`multipart/form-data` in, JSON out).
//
// The kind is decided by the PATH (`/v1/audio/transcriptions`), never by inspecting the body:
// that is what lets this handler forward a body whose file part it must not touch.
//
// The one thing that does change inside the form is the model's provider prefix. routy's ids are
// `<prefix>/<model>` — `openai/whisper-1` — and the upstream wants `whisper-1`. So the form is
// read once (reading is safe), the prefix is stripped, and:
//   • no prefix → the ORIGINAL bytes and the ORIGINAL boundary go upstream, byte for byte;
//   • a prefix  → the form is re-serialized, and the new boundary travels with the new bytes.
// The bug to avoid is mixing them — the client's boundary header with a body we rebuilt — which
// is exactly the failure 9Router's comment about FormData re-encoding warns against. A boundary
// is not stable across serialization, so header and body must always come from the same one.
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

const KIND = "stt";
const STT_TIMEOUT_MS = 300_000; // a long file is the normal case here, not an anomaly

function upstreamUrl(node) {
  const explicit = mediaUrlFor(node, KIND);
  if (explicit) return explicit;
  return `${node.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
}

export function createSttHandler(repos, { timeoutMs = STT_TIMEOUT_MS, maxBytes = 64 * 1024 * 1024 } = {}) {
  const log = rootLog;
  const global429Memo = new Map(); // same memo as the other media handlers

  return async function handleStt(req, res) {
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
    const clientContentType = String(req.headers["content-type"] || "");
    if (!/^multipart\/form-data\b/i.test(clientContentType)) {
      return json(res, 400, { error: { message: "bad_request", detail: "stt expects a multipart/form-data body (fields: model, file, and optionally language, prompt, response_format, temperature)" } });
    }

    const raw = await readBody(req, maxBytes); // Buffer: the wire bytes as they arrived
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "empty multipart body" } });
    }

    // Read the form without disturbing `raw`: this Response is a view for reading, never the
    // thing we send.
    let form;
    try {
      form = await new Response(raw, { headers: { "content-type": clientContentType } }).formData();
    } catch {
      return json(res, 400, { error: { message: "bad_request", detail: "could not read the multipart body — check the boundary in your content-type header" } });
    }

    let declared = form.get("model");
    if (typeof declared !== "string" || declared.trim().length === 0) {
      const queryModel = url.searchParams.get("model");
      if (queryModel && queryModel.trim().length > 0) form.set("model", queryModel.trim()); // client kept it in the URL
      declared = queryModel;
    }
    if (typeof declared !== "string" || declared.trim().length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "model required — as a form field or ?model=" } });
    }

    const slash = declared.indexOf("/");
    const prefix = slash > 0 ? declared.slice(0, slash) : null;
    const upstreamModel = slash > 0 ? declared.slice(slash + 1) : declared;
    const hasFile = form.get("file") !== null;
    if (!hasFile) {
      return json(res, 400, { error: { message: "bad_request", detail: "file required — an audio file (mp3, wav, m4a, webm, ogg, flac)" } });
    }

    const route = resolveRoute(repos, declared, { kind: KIND });
    if (!route) {
      const node = prefix ? repos.nodes.byPrefix(prefix) : null;
      const detail = node && !mediaKindsOf(node).includes(KIND)
        ? `provider '${prefix}' does not serve speech-to-text — declare the stt kind on the node`
        : `"${declared}" is not routable for stt — check the prefix, or that the model exists`;
      return json(res, 400, { error: { message: "bad_request", detail } });
    }
    if (route.kind === "combo") {
      return json(res, 400, { error: { message: "bad_request", detail: `"${route.name}" is a combo — combos for stt are not enabled yet` } });
    }
    // Availability comes from the same plan chat uses (dispatch.mjs): strategy order, the daily
    // budget, whether the node is enabled, and — the part this handler used to miss — an OPEN
    // BREAKER. A node the dashboard shows as down must not keep answering media requests.
    const plan = dispatchPlan(repos, route, { settings });
    if (plan.candidates.length === 0) return unavailableResponse(res, { route, plan });
    const node = route.node;

    const budget = plan.budget;
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

    // The body we send: untouched when nothing in it needed changing, rebuilt once (with its
    // own boundary) when the model's prefix had to come off.
    let bodyText = raw;
    let sendContentType = clientContentType;
    if (slash > 0) {
      form.set("model", upstreamModel);
      const rebuilt = new Response(form);
      bodyText = Buffer.from(await rebuilt.arrayBuffer());
      sendContentType = rebuilt.headers.get("content-type");
      log.debug("STT", `stripped provider prefix "${prefix}" from model — multipart re-serialized with a new boundary`, {
        declared, upstreamModel,
      });
    }

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
        model: upstreamModel,
        signal,
        log,
        url: upstreamUrl(node),
        auth,
        bodyText,                       // the multipart bytes, serialized once above
        contentType: sendContentType,   // and named by their own boundary
      });

      if (!result.ok) {
        lastError = result;
        const settled = settleFailure(repos, {
          node, connection, result, settings,
          recent429: recent429For(recent429, node.id), cooledHere, tag: "STT", log,
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
            route: { node }, connection, clientModel: declared, kind: KIND, status: "rejected",
            durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
          });
          saveMediaDetail(repos, { usageEventId: rejectedId, request: { model: declared } });
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

      const bytes = Buffer.from(await result.response.arrayBuffer().catch(() => new ArrayBuffer(0)));
      const contentType = result.response.headers.get("content-type") || "application/json";

      if (bytes.length === 0) {
        lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "provider returned an empty transcript" };
        recordFailure(repos, node, lastError);
        log.warn("STT", `node ${node.prefix}: empty response`);
        continue;
      }

      recordConnectionSuccess(repos, connection.id);
      recordSuccess(repos, node);
      const usageEventId = recordMediaUsage(repos, log, {
        route: { node }, connection, clientModel: declared, kind: KIND, status: "ok",
        usage: {}, // transcripts carry no token usage in the OpenAI shape (unless verbose_json, read below)
        durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
      });
      // A transcript is text a human may want to read back in the console; audio responses are
      // not stored, but this one is small enough to be worth keeping.
      saveMediaDetail(repos, { usageEventId, request: { model: declared }, response: bytes.toString("utf8") });

      res.writeHead(200, { "content-type": contentType });
      res.end(bytes);
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
