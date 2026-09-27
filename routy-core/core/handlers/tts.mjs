// routy text-to-speech — kind `tts`, uniform OpenAI shape.
//
// The first kind whose SUCCESS response is not JSON: a provider answers with audio bytes, so
// this handler reads bytes rather than a body it can parse, and its delivery decision is what
// `?response_format=json` means for a client that cannot hold raw bytes (a browser, a shell
// that wants `jq`). Everything else — resolve by kind, keys, settlement, usage — is the spine.
//
// Deferred with the bespoke adapters (docs/media-providers.md §3): edge-tts, google-tts and
// local-device are noAuth/local, minimax/nvidia have their own formats, xiaomi-mimo synthesises
// through chat completions. Under the uniform rule this handler speaks OpenAI audio only.
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

const KIND = "tts";
const TTS_TIMEOUT_MS = 180_000; // a long paragraph on a slow voice is still a bounded single call

function upstreamUrl(node) {
  const explicit = mediaUrlFor(node, KIND);
  if (explicit) return explicit;
  return `${node.baseUrl.replace(/\/+$/, "")}/audio/speech`;
}

/** `audio/mpeg` → `mp3` for the JSON envelope's `format` field: `mpeg` is the MIME name, not
 *  the file extension anyone writes. Everything else keeps its subtype, honestly. */
function audioFormat(contentType) {
  const subtype = String(contentType || "").split("/")[1]?.split(";")[0]?.trim() || "";
  const map = { mpeg: "mp3", wave: "wav", "x-m4a": "m4a", "x-wav": "wav", "x-pn-wav": "wav" };
  if (map[subtype]) return map[subtype];
  if (subtype) return subtype;
  return "unknown";
}

export function createTtsHandler(repos, { timeoutMs = TTS_TIMEOUT_MS } = {}) {
  const log = rootLog;
  const global429Memo = new Map(); // same memo as embeddings.mjs and images.mjs

  return async function handleTts(req, res) {
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
    // Only `json` changes what the client receives. Any other value (mp3, wav, …) is a
    // client naming the format it wants — and since routy does not re-encode audio, the bytes
    // are whatever the provider sent, which is the honest answer to every such request.
    const wantJson = url.searchParams.get("response_format") === "json";

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
    if (typeof input !== "string" || input.trim().length === 0) {
      return json(res, 400, { error: { message: "bad_request", detail: "input must be a non-empty string" } });
    }

    const route = resolveRoute(repos, model, { kind: KIND });
    if (!route) {
      const prefix = model.split("/")[0];
      const node = repos.nodes.byPrefix(prefix);
      const detail = node && !mediaKindsOf(node).includes(KIND)
        ? `provider '${prefix}' does not serve text-to-speech — declare the tts kind on the node`
        : `"${model}" is not routable for tts — check the prefix, or that the voice exists`;
      return json(res, 400, { error: { message: "bad_request", detail } });
    }
    if (route.kind === "combo") {
      return json(res, 400, { error: { message: "bad_request", detail: `"${route.name}" is a combo — combos for tts are not enabled yet` } });
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

    const outbound = { ...body, model: route.model };
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
          recent429: recent429For(recent429, node.id), cooledHere, tag: "TTS", log,
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

      const contentType = result.response.headers.get("content-type") || "";
      const bytes = Buffer.from(await result.response.arrayBuffer().catch(() => new ArrayBuffer(0)));

      // A 200 that is actually an error, or nothing at all: treat it as the provider's
      // failure rather than serving silence dressed as speech.
      if (bytes.length === 0) {
        lastError = { ok: false, status: 502, errorCode: "upstream_error", message: "provider returned an empty body" };
        recordFailure(repos, node, lastError);
        log.warn("TTS", `node ${node.prefix}: empty audio response`);
        continue;
      }
      if (contentType.includes("json") || contentType.startsWith("text/")) {
        const parsed = safeJson(bytes.toString("utf8"));
        const providerMessage = parsed?.error?.message || bytes.toString("utf8").slice(0, 160);
        // JSON on an audio endpoint means the provider is talking, not singing. The framing
        // belongs in the message the CLIENT sees, not only in the log: "voice is busy" alone
        // would read like a successful transcript that happens to be empty.
        lastError = { ok: false, status: 502, errorCode: "upstream_error", message: `provider answered with ${contentType} instead of audio: ${providerMessage}` };
        recordFailure(repos, node, lastError);
        log.warn("TTS", `node ${node.prefix}: provider answered with ${contentType} instead of audio — ${String(providerMessage).slice(0, 160)}`);
        continue;
      }

      recordConnectionSuccess(repos, connection.id);
      recordSuccess(repos, node);

      const audioType = contentType || "audio/mpeg"; // OpenAI's default; a uniform provider sends audio/*
      const format = audioFormat(audioType);
      const usageEventId = recordMediaUsage(repos, log, {
        route: { node }, connection, clientModel: model, kind: KIND, status: "ok",
        usage: {}, // audio carries no token usage; recording zeros would look like data
        durationMs: Date.now() - t0, apiKeyId, pool: proxy?.poolName ?? null, attempts,
      });
      // Only the request is stored: an audio response is megabytes of diagnostics nobody reads
      // (the same call images makes for the same reason).
      saveMediaDetail(repos, { usageEventId, request: outbound });

      if (wantJson) {
        const envelope = JSON.stringify({ audio: bytes.toString("base64"), format });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(envelope);
        return;
      }
      res.writeHead(200, { "content-type": audioType, "content-length": String(bytes.length) });
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

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
