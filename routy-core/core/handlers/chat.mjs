// routy chat handler — /v1/chat/completions + /v1/messages.
// P1.6: openai↔claude/responses translation via the ported translator. P1.6b:
// forced-SSE→JSON conversion + body-based source detection (upstream parity).
import { readBody, json } from "../../lib/router.mjs";
import { extractBearer } from "../../lib/auth.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute, orderRoutes } from "../routing.mjs";
import {
  recordConnectionFailure, recordConnectionSuccess, connectionState, isConnectionAvailable,
  earliestRecovery,
} from "../key-health.mjs";
import { observeTtft } from "../latency.mjs";
import { maskKey } from "../../lib/mask.mjs";
import { costOf, isMetered } from "../pricing.mjs";
import { addSpend, budgetState } from "../budget.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { formatSse } from "../sse/parser.mjs";
import { pumpSse, UsageTracker, LogBuffer } from "../sse/stream.mjs";
import { parseSSEToOpenAIResponse } from "../sse/sseToJson.mjs";
import { createResponseTranslator } from "../sse/translateStream.mjs";
import { translateRequest, needsTranslation } from "../translate/index.js";
import { FORMATS, detectFormatByEndpoint } from "../translate/formats.js";
import { detectFormat } from "../translate/deps/detectFormat.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { FAILURE_THRESHOLD, OPEN_MS, MAX_OPEN_MS, STREAM_IDLE_TIMEOUT_MS } from "../limits.mjs";

// How long a provider-wide 429 keeps a node+model out of dispatch when the provider sent
// no Retry-After. Short: the point is to stop re-probing a saturated model on every
// request, not to lock the model out.
const UPSTREAM_429_MEMO_MS = 60_000;
// Stall watchdog: abort a stream that goes this long without a chunk. Reasoning
// models can think for a while, so the default is generous; nodes can override
// (or disable with 0) via data.streamIdleTimeoutMs.

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

export function createChatHandler(repos, { streamIdleTimeoutMs } = {}) {
  const log = rootLog;
  const globalIdleTimeoutMs = streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  // nodeId|model -> timestamp a provider-wide 429 was reported until. Per handler (RAM):
  // a restart forgetting it merely costs one re-probe.
  const global429Memo = new Map();

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

    // Combo order follows its strategy (fallback/fastest/cheapest/round-robin/sticky);
    // then the daily budget drops metered routes once the ceiling is reached, so an
    // exhausted budget falls through to a free/local node instead of failing.
    const ordered = route.kind === "combo"
      ? orderRoutes(route.routes, {
          strategy: route.strategy,
          rotate: comboTurn(route.id ?? route.name, route.strategy, route.stickyLimit),
        })
      : [route];
    const budget = budgetState(settings.budgetUsdPerDay);
    const routes = budget.over ? ordered.filter((r) => r.kind === "node" && !isMetered(r.node)) : ordered;
    res.on("close", () => clientAbort.abort());
    let lastError = null;

    if (routes.length === 0 && budget.over) {
      return json(res, 402, {
        error: {
          message: "budget_exceeded",
          detail: `daily budget of $${budget.limit} spent ($${budget.spent.toFixed(4)}); no unmetered route available`,
          spentUsd: budget.spent,
          limitUsd: budget.limit,
          retryAfterMs: budget.retryAfterMs,
        },
      });
    }

    // Fail fast when every route has an open breaker — hammering a dead upstream
    // is what the breaker exists to prevent.
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

    // How many upstream attempts this request needed. 1 is the healthy path; higher
    // means rotation or combo fallback earned its keep, which is invisible in a
    // successful response otherwise.
    let attempts = 0;

    // Round-robin per request within a node, then combo-fallback across nodes. The key
    // loop lives inside the node loop: a key problem rotates to the node's next key, a
    // node problem advances to the next node — the two failure domains must not blur.
    const recent429 = new Map(); // nodeId -> Set of connectionIds that 429'd on this model
    for (const r of candidates) {
      // A node+model we have already proven saturated stays saturated for the window the
      // provider asked for. Without this, every client request would re-probe the same
      // wall with every key — the exact load the global verdict exists to avoid.
      const saturatedUntil = global429Memo.get(`${r.node.id}|${r.model}`);
      if (saturatedUntil && Date.now() < saturatedUntil) {
        return json(res, 429, {
          error: {
            message: "upstream_rate_limited",
            detail: `provider ${r.node.prefix} is still rate-limiting this model for everyone — pick another upstream or model`,
            retryAfterMs: saturatedUntil - Date.now(),
          },
        });
      }

      const keys = pickConnections(repos, r.node);
      if (keys.length === 0) {
        // Two different situations, and saying the wrong one sends the user looking for
        // a key that is already there: no key configured at all, versus every key on the
        // node side-lined (cooling or disabled) with relief on its way.
        const all = repos.connections.list(r.node.id);
        const recovery = earliestRecovery(repos, all);
        if (all.length === 0) {
          lastError = { status: 503, errorCode: "no_credentials", message: `no active connection for node ${r.node.prefix}` };
        } else {
          const usable = all.filter((c) => c.status === "active").length;
          lastError = {
            status: 503,
            errorCode: "all_keys_exhausted",
            message: recovery
              ? `all ${all.length} keys of ${r.node.prefix} are cooling down or disabled (${usable} active, none usable)`
              : `all ${all.length} keys of ${r.node.prefix} are disabled`,
            retryAfterMs: recovery ? Math.max(0, recovery - Date.now()) : null,
          };
        }
        continue;
      }

      let nodeDied = false; // a 5xx/timeout: stop rotating this node's keys, advance node
      let lastKeyError = null;
      const cooledHere = []; // cooldowns applied during this node's attempt, for rollback

      for (const connection of keys) {
        const targetFormat = targetFormatForNode(r.node);
        const translate = needsTranslation(sourceFormat, targetFormat);

        let outbound = { ...body, model: r.model };
        let toolNameMap = null;
        let customToolNames = null;
        if (translate) {
          if (!stream && (targetFormat === FORMATS.CLAUDE || targetFormat === FORMATS.OPENAI_RESPONSES)) {
            lastError = { status: 501, errorCode: "not_implemented", message: "non-streaming + translation lands in P1.6b" };
            nodeDied = true;
            break;
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
            nodeDied = true;
            break;
          }
        }
        // RTK token saver — final outbound body, after translation, before dispatch
        // (upstream placement). Default-on unless settings disable it.
        if (settings.rtkEnabled !== false) {
          const rtkStats = compressMessages(outbound, true);
          if (rtkStats?.hits?.length) log.debug("RTK", formatRtkLog(rtkStats));
        }

        const executor = new DefaultExecutor(r.node, connection);
        // Per-node stall budget; 0 disables the watchdog.
        const idleTimeoutMs = r.node.data?.streamIdleTimeoutMs ?? globalIdleTimeoutMs;
        attempts++;
        const result = await executor.execute({ model: r.model, body: outbound, stream, signal: clientAbort.signal, log });

        if (!result.ok) {
          // A client walking away (or a client-side timeout) says nothing about the
          // provider's health. Counting it degrades a perfectly good node and, after
          // three, opens its breaker — so aborts never touch the breaker.
          if (result.errorCode === "client_aborted") {
            log.info("CHAT", `client aborted ${r.node.prefix}`, { afterMs: Date.now() - t0 });
            lastError = result;
            return json(res, 499, { error: { message: "client_aborted", detail: "client aborted the request" } });
          }

          const verdict = recordConnectionFailure(repos, connection, result, settings, Date.now(), recent429For(recent429, r.node.id));
          if (verdict.verdict === "global") {
            // Provider-wide saturation: no key is at fault and rotating would burn the
            // whole list against a wall. Any cooldown this attempt already applied was
            // based on evidence that has just been overruled — undo it, so the keys come
            // out of a provider-wide limit exactly as they went in.
            for (const id of cooledHere) recordConnectionSuccess(repos, id);
            const until = Date.now() + (result.retryAfterMs ?? UPSTREAM_429_MEMO_MS);
            global429Memo.set(`${r.node.id}|${r.model}`, until);
            log.warn("CHAT", `node ${r.node.prefix}: upstream-wide rate limit — not a key problem, failing through`, {
              keys: keys.length, errorCode: result.errorCode, rolledBack: cooledHere.length,
            });
            return json(res, 429, {
              error: {
                message: "upstream_rate_limited",
                detail: `provider ${r.node.prefix} is rate-limiting this model for everyone${verdict.others ? ` (429 across ${verdict.others} keys)` : ""} — not a per-key credit or rate-limit issue; pick another upstream or model`,
                retryAfterMs: Math.max(0, until - Date.now()),
              },
            });
          }

          if (verdict.verdict === "node") {
            // Not the key's fault: the node breaker owns it, and rotating keys into a
            // sick upstream would just multiply the load by the key count.
            recordFailure(repos, r.node, result);
            lastError = result;
            log.warn("CHAT", `node ${r.node.prefix} failed: ${result.errorCode} ${result.status}`);
            nodeDied = true;
            break; // advance to the next node
          }

          lastError = result;
          // One label for every key-scoped line: name to read, mask to disambiguate
          // keys that share a name (auto-named ones do until they are renamed).
          const keyLabel = `${connection.name} (${maskKey(connection.credentials?.apiKey)})`;
          if (verdict.verdict === "cooldown") {
            cooledHere.push(connection.id);
            log.warn("CHAT", `node ${r.node.prefix} key "${keyLabel}" cooling down ${Math.round(verdict.cooldownMs / 1000)}s: ${verdict.reason}`);
          } else if (verdict.verdict === "disable") {
            log.warn("CHAT", `node ${r.node.prefix} key "${keyLabel}" DISABLED after ${verdict.strikes} strikes: ${verdict.reason}`);
          } else {
            log.warn("CHAT", `node ${r.node.prefix} key "${keyLabel}" strike ${verdict.strikes}/2: ${verdict.reason}`);
          }
          lastKeyError = { ...result, keyLabel };
          continue; // rotate to the node's next key
        }

        recordConnectionSuccess(repos, connection.id);

        // NOTE: success is recorded when the response is actually known good —
        // headers alone are not enough, since a stream can die mid-flight.

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

          const { clientGone, completed, stalled, errored, frames, bytes, durationMs } = await pumpSse({
            upstream: result.response, res, signal: clientAbort.signal, t0, usage, logBuffer,
            transform, flushFrames, trailingDone, idleTimeoutMs,
          });
          // Only a client that left BEFORE the answer was complete is an abort. Agents
          // like Hermes close the socket the moment they see finish_reason, which is a
          // successful request, and charging it as an abort meant the node was never
          // credited, its latency was never learned, and every such call showed up in
          // Recent failures.
          const genuineAbort = clientGone && !completed;
          log.debug("UPSTREAM", `← stream end ${r.node.prefix}`, {
            frames, bytes, durationMs, stalled, errored, clientGone, completed,
            ttftMs: usage.ttftMs ?? null,
          });
          if (errored) {
            // Upstream broke mid-stream (stall or death) — that is node health, not
            // a client problem, so it counts against the breaker like any other failure.
            recordFailure(repos, r.node, {
              errorCode: stalled ? "upstream_stalled" : "upstream_stream_failed",
              status: 504,
              message: stalled ? `no upstream data for ${idleTimeoutMs}ms` : "upstream stream failed mid-response",
            });
            log.warn("CHAT", `node ${r.node.prefix} stream broke (${stalled ? "stalled" : "failed"})`);
          } else if (!genuineAbort) {
            recordSuccess(repos, r.node);
          }

          let promptTokens = usage.promptTokens;
          let completionTokens = usage.completionTokens;
          if (translate && translator.state?.usage) {
            promptTokens = translator.state.usage.prompt_tokens ?? promptTokens;
            completionTokens = translator.state.usage.completion_tokens ?? completionTokens;
          }
          const usageEventId = recordUsage(repos, log, r, connection, body.model, {
            status: errored ? "error" : genuineAbort ? "aborted" : "ok",
            usage: { promptTokens, completionTokens, ttftMs: usage.ttftMs },
            durationMs: Date.now() - t0,
            apiKeyId,
            attempts,
          });
          saveDetail(repos, { usageEventId, request: body, responseText: logBuffer, truncated: logBuffer.truncated });
          return;
        }

        // ── non-streaming: passthrough JSON; convert provider-forced SSE → JSON (P1.6b) ──
        const upstreamCt = result.response.headers?.get?.("content-type") || "";
        let text;
        try {
          text = await withIdleTimeout(result.response.text(), idleTimeoutMs, () => result.abort?.());
        } catch (err) {
          // Distinguish "the client left" from "the upstream stalled" — the first is
          // not the provider's fault and must not degrade it.
          if (clientAbort.signal.aborted) {
            log.info("CHAT", `client aborted ${r.node.prefix} while reading the body`, { afterMs: Date.now() - t0 });
            return;
          }
          // Same watchdog as the stream path: a body that never arrives must not hang.
          recordFailure(repos, r.node, { errorCode: "upstream_stalled", status: 504, message: err.message });
          lastError = { status: 504, errorCode: "upstream_stalled", message: err.message };
          log.warn("CHAT", `node ${r.node.prefix} stalled reading body`);
          nodeDied = true;
          break;
        }
        const usage = new UsageTracker({ promptText: JSON.stringify(body.messages || "") });
        let parsed = null;
        if (upstreamCt.includes("text/event-stream")) {
          parsed = parseSSEToOpenAIResponse(text, r.model);
          if (parsed?.error) {
            recordFailure(repos, r.node, { errorCode: "upstream_error", status: 502, message: JSON.stringify(parsed.error).slice(0, 200) });
            return json(res, 502, { error: { message: "upstream_error", detail: JSON.stringify(parsed.error).slice(0, 300) } });
          }
          if (!parsed) {
            recordFailure(repos, r.node, { errorCode: "upstream_error", status: 502, message: "empty stream for a non-streaming request" });
            return json(res, 502, { error: { message: "upstream_error", detail: "upstream sent an empty stream for a non-streaming request" } });
          }
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
        recordSuccess(repos, r.node);
        const usageEventId = recordUsage(repos, log, r, connection, body.model, { status: "ok", usage, durationMs: Date.now() - t0, apiKeyId, attempts });
        saveDetail(repos, { usageEventId, request: body, responseText: new LogBuffer(), truncated: false });
        return;
      }

      // This node's keys are exhausted (cooling/disabled) or the node itself failed.
      // Distinguish them so the response can say which, and when relief arrives.
      if (nodeDied) continue; // combo fallback: next node
      const recovery = earliestRecovery(repos, keys);
      const retryAfterMs = recovery ? Math.max(0, recovery - Date.now()) : null;
      if (lastKeyError) {
        // The last failure's own Retry-After only speaks for that one key; when keys are
        // cooling, the soonest cooldown expiry is the honest answer to "when can I retry".
        lastError = {
          ...lastKeyError,
          errorCode: "all_keys_exhausted",
          message: `all ${keys.length} keys of ${r.node.prefix} failed — last: ${lastKeyError.errorCode} (${lastKeyError.keyLabel})`,
          retryAfterMs: lastKeyError.retryAfterMs ?? retryAfterMs,
        };
      } else if (recovery) {
        lastError = { status: 503, errorCode: "all_keys_exhausted", message: `all ${keys.length} keys of ${r.node.prefix} are cooling down or disabled`, retryAfterMs };
      }
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

/**
 * Race a promise against an idle budget. onTimeout fires when the budget is
 * exhausted (used to abort the upstream request), then the promise rejects.
 */
async function withIdleTimeout(promise, timeoutMs, onTimeout) {
  if (!timeoutMs) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch { /* best-effort abort */ }
          reject(new Error(`no upstream data for ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Per-combo dispatch cursor (RAM; a restart merely restarts the cycle). Only the
// strategies that rotate consult it, so switching a combo to `fastest` and back does
// not leave the rotation mid-cycle.
const comboCursor = new Map();

/**
 * Which turn of the rotation this request is.
 *   round-robin — advances every request
 *   sticky      — advances every `stickyLimit` requests, so a conversation keeps
 *                 hitting the same member (prompt-cache affinity) before moving on
 * Every other strategy ignores the cursor and keeps declared/ranked order.
 */
function comboTurn(comboName, strategy, stickyLimit = 1) {
  if (strategy !== "round-robin" && strategy !== "sticky") return 0;
  const n = comboCursor.get(comboName) ?? 0;
  comboCursor.set(comboName, n + 1);
  return strategy === "sticky" ? Math.floor(n / Math.max(1, stickyLimit || 1)) : n;
}

// Round-robin cursor per node (RAM; resets on restart, which merely restarts the
// rotation). Connections.list is ORDER BY priority, created_at, so the rotation
// preserves the user's priority order within each turn.
const rrCursor = new Map();

/**
 * Keys of `node` in dispatch order: active in the DB, not cooling/disabled in the
 * health store, then ordered by the provider's key strategy. Empty means nothing to
 * serve with.
 *
 *   round-robin (default) — start at a different key each request, spreading load
 *   fallback              — always start at the first usable key, so a primary key
 *                           carries everything until it fails; the fallover to the
 *                           next key still happens inside the same request
 */
function pickConnections(repos, node) {
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
function recent429For(map, nodeId) {
  let set = map.get(nodeId);
  if (!set) { set = new Set(); map.set(nodeId, set); }
  return set;
}

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

function recordSuccess(repos, node) {
  repos.breakers.record(`node:${node.id}`, { state: "closed", failures: 0, openUntil: null, lastError: null });
}

function recordUsage(repos, log, route, connection, clientModel, { status, usage, durationMs, apiKeyId, attempts = 1 }) {
  // Metered nodes carry pricing config; unmetered ones record null and can never
  // consume budget. Latency memory is fed here so routing has one write path.
  const costUsd = costOf(route.node, { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens });
  if (Number.isFinite(costUsd)) addSpend(costUsd);
  if (status === "ok" && Number.isFinite(usage.ttftMs)) observeTtft(route.node.id, usage.ttftMs);

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
    costUsd: Number.isFinite(costUsd) ? costUsd : null,
  });
  // Console visibility on the healthy path (ui-ux contract round 2, item 5a).
  // The key label belongs here as much as on the failure lines: with rotation live,
  // "which key served this?" is the question a successful line otherwise cannot answer.
  const genMs = Number.isFinite(usage.ttftMs) ? durationMs - usage.ttftMs : durationMs;
  // A generation window this short cannot measure a rate: an upstream that answers in
  // one burst leaves a 1ms window, and dividing 544 tokens by it reports half a million
  // tokens per second. Below the threshold the honest answer is "no rate", not a
  // spectacular one.
  const RATE_WINDOW_MIN_MS = 250;
  const tokensPerSec = usage.completionTokens > 0 && genMs >= RATE_WINDOW_MIN_MS
    ? Number((usage.completionTokens / (genMs / 1000)).toFixed(1))
    : null;
  log.info("REQ", `${route.node.prefix} ← ${status}`, {
    requestId: event.id,
    model: clientModel,
    nodeId: route.node.id,
    connectionId: connection.id,
    key: `${connection.name} (${maskKey(connection.credentials?.apiKey)})`,
    status,
    attempts,
    ttftMs: usage.ttftMs ?? null,
    durationMs,
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    tokensPerSec,
    costUsd: Number.isFinite(costUsd) ? Number(costUsd.toFixed(6)) : null,
  });
  return event.id;
}

function saveDetail(repos, { usageEventId = null, request, responseText, truncated }) {
  try {
    repos.requestDetails.save({ usageEventId, kind: "request", content: { body: request } });
    if (responseText?.text?.length > 0) {
      repos.requestDetails.save({ usageEventId, kind: "response", content: responseText.text, truncated });
    }
  } catch { /* details must never break the proxy */ }
}
