// RE-E chat handler — /v1/chat/completions + /v1/messages.
// P1.6: openai↔claude/responses translation via the ported translator. P1.6b:
// forced-SSE→JSON conversion + body-based source detection (upstream parity).
import { readBody, json } from "../../lib/router.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute } from "../routing.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { formatSse } from "../sse/parser.mjs";
import { pumpSse, UsageTracker, LogBuffer } from "../sse/stream.mjs";
import { parseSSEToOpenAIResponse } from "../sse/sseToJson.mjs";
import { createResponseTranslator } from "../sse/translateStream.mjs";
import { translateRequest, needsTranslation } from "../translate/index.js";
import { FORMATS, detectFormatByEndpoint } from "../translate/formats.js";
import { detectFormat } from "../translate/deps/detectFormat.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";

const FAILURE_THRESHOLD = 3;
const OPEN_MS = 60_000;

// Verbatim from upstream chatCore.js:50-59 — never send translator stashes upstream.
function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

function targetFormatForNode(node) {
  if (node.apiType === "anthropic") return FORMATS.CLAUDE;
  if (node.apiType === "responses") return FORMATS.OPENAI_RESPONSES;
  return FORMATS.OPENAI;
}

export function createChatHandler(repos) {
  const log = rootLog;

  async function handleChatCompletions(req, res) {
    const t0 = Date.now();

    // auth (router client key)
    const settings = repos.settings.all();
    let apiKeyId = null;
    if (settings.requireApiKey !== false) {
      const token = extractBearer(req);
      const key = token ? repos.apiKeys.verify(token) : null;
      if (!key) {
        return json(res, 401, { error: { message: "auth_error", detail: "valid API key required" } });
      }
      apiKeyId = key.id;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8"));
    } catch (err) {
      return json(res, err?.statusCode === 413 ? 413 : 400, { error: { message: "bad_request", detail: "invalid JSON body" } });
    }

    // Source format: endpoint override first, then body heuristic (upstream parity,
    // services/provider.js detectFormat) — e.g. claude-shaped body with a slash-model
    // on /v1/chat/completions stays openai.
    const pathname = new URL(req.url, "http://localhost").pathname;
    const sourceFormat = detectFormatByEndpoint(pathname, body) || detectFormat(body);

    const route = resolveRoute(repos, body.model);
    if (!route) {
      return json(res, 404, { error: { message: "invalid_model", detail: `unresolvable model: ${body.model}` } });
    }

    const stream = body.stream !== false; // claude clients often omit; explicit false respected
    const clientAbort = new AbortController();

    const routes = route.kind === "combo" ? orderRoutes(route.routes) : [route];
    res.on("close", () => clientAbort.abort());
    let lastError = null;

    // Fail fast when every route has an open breaker — hammering a dead upstream
    // is what the breaker exists to prevent. Half-open probing lands in P3.
    const candidates = routes.filter((r) => r.kind === "node" && r.healthy);
    if (candidates.length === 0) {
      const expiries = routes
        .filter((r) => r.kind === "node")
        .map((r) => repos.breakers.get(`node:${r.node.id}`))
        .filter((b) => b && b.openUntil)
        .map((b) => Date.parse(b.openUntil))
        .filter((t) => Number.isFinite(t));
      const retryAfterMs = expiries.length ? Math.max(0, Math.max(...expiries) - Date.now()) : null;
      return json(res, 503, { error: { message: "all_unavailable", detail: "all routes have open breakers", retryAfterMs } });
    }

    for (const r of candidates) {
      const connection = pickConnection(repos, r.node);
      if (!connection) {
        lastError = { status: 503, errorCode: "no_credentials", message: `no active connection for node ${r.node.prefix}` };
        continue;
      }

      const targetFormat = targetFormatForNode(r.node);
      const translate = needsTranslation(sourceFormat, targetFormat);

      let outbound = { ...body, model: r.model };
      let toolNameMap = null;
      let customToolNames = null;
      if (translate) {
        if (!stream && (targetFormat === FORMATS.CLAUDE || targetFormat === FORMATS.OPENAI_RESPONSES)) {
          lastError = { status: 501, errorCode: "not_implemented", message: "non-streaming + translation lands in P1.6b" };
          continue;
        }
        try {
          outbound = translateRequest(sourceFormat, targetFormat, r.model, structuredClone(body), stream, {}, null, null, [], null, null);
          if (!outbound) throw new Error("translateRequest returned falsy");
          toolNameMap = outbound._toolNameMap; delete outbound._toolNameMap;
          customToolNames = outbound._customToolNames; delete outbound._customToolNames;
          outbound.model = r.model;
          stripContinuityFields(outbound);
        } catch (err) {
          lastError = { status: 400, errorCode: "translate_error", message: String(err?.message || err) };
          continue;
        }
      }
      // RTK token saver — final outbound body, after translation, before dispatch
      // (upstream placement). Default-on unless settings disable it.
      if (settings.rtkEnabled !== false) {
        const rtkStats = compressMessages(outbound, true);
        if (rtkStats?.hits?.length) log.debug("RTK", formatRtkLog(rtkStats));
      }

      const executor = new DefaultExecutor(r.node, connection);
      const result = await executor.execute({ model: r.model, body: outbound, stream, signal: clientAbort.signal, log });

      if (!result.ok) {
        recordFailure(repos, r.node, result);
        lastError = result;
        log.warn("CHAT", `node ${r.node.prefix} failed: ${result.errorCode} ${result.status}`);
        continue; // combo fallback
      }

      recordSuccess(repos, r.node);

      // ── streaming: translate or passthrough ──
      if (stream && result.response.headers?.get?.("content-type")?.includes("text/event-stream")) {
        const usage = new UsageTracker({ promptText: JSON.stringify(body.messages || body.input || "") });
        const logBuffer = new LogBuffer();
        let translator = null;
        let transform;
        let flushFrames = null;
        let trailingDone = false;

        if (translate) {
          translator = createResponseTranslator({
            sourceFormat, targetFormat, model: r.model, body, toolNameMap, customToolNames,
          });
          transform = (frame) => translator.onFrame(frame);
          flushFrames = () => translator.flush();
        } else {
          // Passthrough (P1.5): usage injection on the terminal chunk + double [DONE] parity
          transform = (frame) => {
            if (frame.data === "[DONE]" || !frame.data.includes('"finish_reason"')) {
              return [formatSse(frame.event, frame.data)];
            }
            try {
              const obj = JSON.parse(frame.data);
              const choice = obj.choices?.[0];
              if (choice?.finish_reason && !obj.usage) {
                obj.usage = {
                  prompt_tokens: usage.promptTokens,
                  completion_tokens: usage.completionTokens,
                  total_tokens: usage.promptTokens + usage.completionTokens,
                  estimated: true,
                };
              }
              return [formatSse(frame.event, JSON.stringify(obj))];
            } catch {
              return [formatSse(frame.event, frame.data)];
            }
          };
          trailingDone = true;
        }

        const { clientGone } = await pumpSse({
          upstream: result.response, res, signal: clientAbort.signal, t0, usage, logBuffer,
          transform, flushFrames, trailingDone,
        });

        let promptTokens = usage.promptTokens;
        let completionTokens = usage.completionTokens;
        if (translate && translator.state?.usage) {
          promptTokens = translator.state.usage.prompt_tokens ?? promptTokens;
          completionTokens = translator.state.usage.completion_tokens ?? completionTokens;
        }
        recordUsage(repos, r, connection, body.model, {
          status: clientGone ? "aborted" : "ok",
          usage: { promptTokens, completionTokens, ttftMs: usage.ttftMs },
          durationMs: Date.now() - t0,
          apiKeyId,
        });
        saveDetail(repos, { request: body, responseText: logBuffer, truncated: logBuffer.truncated });
        return;
      }

      // ── non-streaming: passthrough JSON; convert provider-forced SSE → JSON (P1.6b) ──
      const upstreamCt = result.response.headers?.get?.("content-type") || "";
      const text = await result.response.text();
      const usage = new UsageTracker({ promptText: JSON.stringify(body.messages || "") });
      let parsed = null;
      if (upstreamCt.includes("text/event-stream")) {
        parsed = parseSSEToOpenAIResponse(text, r.model);
        if (parsed?.error) {
          return json(res, 502, { error: { message: "upstream_error", detail: JSON.stringify(parsed.error).slice(0, 300) } });
        }
        if (!parsed) return json(res, 502, { error: { message: "upstream_error", detail: "upstream sent an empty stream for a non-streaming request" } });
      } else {
        try { parsed = JSON.parse(text); } catch { /* passthrough as-is */ }
      }
      if (parsed?.usage) {
        usage.promptTokens = parsed.usage.prompt_tokens ?? usage.promptTokens;
        usage.completionTokens = parsed.usage.completion_tokens ?? usage.completionTokens;
        usage.exact = true;
      }
      if (clientAbort.signal.aborted) return; // client gone
      res.writeHead(result.response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(parsed ?? text));
      recordUsage(repos, r, connection, body.model, { status: "ok", usage, durationMs: Date.now() - t0, apiKeyId });
      saveDetail(repos, { request: body, responseText: new LogBuffer(), truncated: false });
      return;
    }

    const err = lastError || { status: 503, errorCode: "all_unavailable", message: "no healthy route" };
    const status = err.errorCode === "auth_error" ? 502 : err.status === 501 ? 501 : err.status === 400 ? 400 : 503;
    return json(res, status, {
      error: {
        message: err.errorCode || "all_unavailable",
        detail: (err.message || "").slice(0, 500),
        retryAfterMs: err.retryAfterMs ?? null,
      },
    });
  }

  return handleChatCompletions;
}

function extractBearer(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function pickConnection(repos, node) {
  const list = repos.connections.list(node.id).filter((c) => c.status === "active");
  return list[0] || null;
}

function orderRoutes(routes) {
  const healthy = routes.filter((r) => r.healthy && r.kind === "node");
  const rest = routes.filter((r) => !(r.healthy && r.kind === "node"));
  return [...healthy, ...rest];
}

export function recordFailure(repos, node, err) {
  const scope = `node:${node.id}`;
  const cur = repos.breakers.record(scope, { failureDelta: 1, lastError: `${err.errorCode}: ${(err.message || "").slice(0, 200)}` });
  if (cur.failures >= FAILURE_THRESHOLD) {
    repos.breakers.record(scope, {
      state: "open",
      openUntil: new Date(Date.now() + OPEN_MS).toISOString(),
    });
  }
}

function recordSuccess(repos, node) {
  repos.breakers.record(`node:${node.id}`, { state: "closed", failures: -999, lastError: null });
}

function recordUsage(repos, route, connection, clientModel, { status, usage, durationMs, apiKeyId }) {
  const event = repos.usage.record({
    nodeId: route.node.id,
    connectionId: connection.id,
    apiKeyId: apiKeyId ?? null,
    model: clientModel,
    status,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ttftMs: usage.ttftMs ?? null,
    durationMs,
  });
  // Console visibility on the healthy path (ui-ux contract round 2, item 5a)
  log.info("REQ", `${route.node.prefix} ← ${status}`, {
    requestId: event?.id ?? null,
    model: clientModel,
    nodeId: route.node.id,
    status,
    ttftMs: usage.ttftMs ?? null,
    durationMs,
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
  });
}

function saveDetail(repos, { request, responseText, truncated }) {
  try {
    repos.requestDetails.save({ kind: "request", content: { body: request } });
    if (responseText?.text?.length > 0) {
      repos.requestDetails.save({ kind: "response", content: responseText.text, truncated });
    }
  } catch { /* details must never break the proxy */ }
}
