// RE-E chat handler — /v1/chat/completions (openai source format).
// P1.5 scope: openai→openai passthrough (stream + non-stream), combo fallback,
// breaker integration, usage recording. Claude source + format translation: P1.6.
import { readBody, json } from "../../lib/router.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute } from "../routing.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { formatSse } from "../sse/parser.mjs";
import { pumpSse, UsageTracker, LogBuffer } from "../sse/stream.mjs";
const FAILURE_THRESHOLD = 3;
const OPEN_MS = 60_000;

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

    // route
    const route = resolveRoute(repos, body.model);
    if (!route) {
      return json(res, 404, { error: { message: "invalid_model", detail: `unresolvable model: ${body.model}` } });
    }

    const wantStream = body.stream !== false;
    const clientAbort = new AbortController();
    res.on("close", () => clientAbort.abort());
    const routes = route.kind === "combo" ? orderRoutes(route.routes) : [route];
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
      return json(res, 503, {
        error: { message: "all_unavailable", detail: "all routes have open breakers", retryAfterMs },
      });
    }

    for (const r of candidates) {

      const connection = pickConnection(repos, r.node);
      if (!connection) {
        lastError = { status: 503, errorCode: "no_credentials", message: `no active connection for node ${r.node.prefix}` };
        continue;
      }
      if (r.node.apiType !== "openai") {
        // openai→responses (and claude targets) need the translator — P1.6
        lastError = { status: 501, errorCode: "not_implemented", message: `apiType ${r.node.apiType} requires translation (P1.6)` };
        continue;
      }

      const executor = new DefaultExecutor(r.node, connection);
      const result = await executor.execute({ model: r.model, body, stream: wantStream, signal: clientAbort.signal, log });

      if (!result.ok) {
        recordFailure(repos, r.node, result);
        lastError = result;
        log.warn("CHAT", `node ${r.node.prefix} failed: ${result.errorCode} ${result.status}`);
        continue; // combo fallback
      }

      recordSuccess(repos, r.node);

      if (wantStream && result.response.headers?.get?.("content-type")?.includes("text/event-stream")) {
        const usage = new UsageTracker({ promptText: JSON.stringify(body.messages || body.input || "") });
        const logBuffer = new LogBuffer();
        // Terminal-chunk usage injection (upstream parity): clients read usage from the
        // finish_reason chunk. Only frames containing "finish_reason" are parsed —
        // delta chunks pass through untouched (near-zero hot-path cost).
        const transform = (frame) => {
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
        const { clientGone } = await pumpSse({
          upstream: result.response, res, signal: clientAbort.signal, t0, usage, logBuffer, transform,
          trailingDone: true, // upstream emits [DONE] twice in passthrough — parity
        });
        recordUsage(repos, r, connection, body.model, {
          status: clientGone ? "aborted" : "ok", usage, durationMs: Date.now() - t0, apiKeyId,
        });
        saveDetail(repos, { request: body, responseText: logBuffer, truncated: logBuffer.truncated });
        return;
      }

      // non-streaming (or upstream ignored stream=false contract and sent JSON)
      const text = await result.response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* passthrough as-is */ }
      const usage = new UsageTracker({ promptText: JSON.stringify(body.messages || "") });
      if (parsed?.usage) {
        usage.promptTokens = parsed.usage.prompt_tokens ?? usage.promptTokens;
        usage.completionTokens = parsed.usage.completion_tokens ?? usage.completionTokens;
        usage.exact = true;
      } else {
        usage.completionTokens = estimateOf(text);
      }
      const status = clientAbort.signal.aborted ? 499 : result.response.status;
      if (status === 499) return; // client gone
      res.writeHead(result.response.status, { "content-type": result.response.headers?.get?.("content-type") || "application/json" });
      res.end(text);
      recordUsage(repos, r, connection, body.model, { status: "ok", usage, durationMs: Date.now() - t0, apiKeyId });
      saveDetail(repos, { request: body, responseText: new LogBuffer(), truncated: false });
      return;
    }

    // all routes exhausted
    const err = lastError || { status: 503, errorCode: "all_unavailable", message: "no healthy route" };
    const status = err.errorCode === "auth_error" ? 502 : err.status === 501 ? 501 : 503;
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
  repos.usage.record({
    nodeId: route.node.id,
    connectionId: connection.id,
    apiKeyId: apiKeyId ?? null,
    model: clientModel,
    status,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ttftMs: usage.ttftMs,
    durationMs,
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

function estimateOf(text) {
  return Math.ceil((text || "").length / 4);
}
