// routy chat handler — /v1/chat/completions + /v1/messages.
// P1.6: openai↔claude/responses translation via the ported translator. P1.6b:
// forced-SSE→JSON conversion + body-based source detection (upstream parity).
import { readBody, json } from "../../lib/router.mjs";
import { extractBearer } from "../../lib/auth.mjs";
import { log as rootLog } from "../../lib/log.mjs";
import { resolveRoute, orderRoutes } from "../routing.mjs";
import {
  classifyConnectionError, recordConnectionFailure, recordConnectionSuccess,
  earliestRecovery,
} from "../key-health.mjs";
import { pickConnections, recent429For, recordFailure, recordSuccess, comboTurn, describeCombo } from "../dispatch.mjs";
import { stripUnsupportedParams } from "../translate/concerns/paramSupport.js";
import { observeTtft } from "../latency.mjs";
import { maskKey } from "../../lib/mask.mjs";
import { resolveNodeProxy } from "../proxy.mjs";
import { costOf, isMetered } from "../pricing.mjs";
import { addSpend, budgetState } from "../budget.mjs";
import { DefaultExecutor } from "../executors/default.mjs";
import { OpenCodeExecutor, opencodeSpeaksResponses } from "../executors/opencode.mjs";
import { formatSse } from "../sse/parser.mjs";
import { pumpSse, UsageTracker, LogBuffer } from "../sse/stream.mjs";
import { parseSSEToOpenAIResponse } from "../sse/sseToJson.mjs";
import { createResponseTranslator } from "../sse/translateStream.mjs";
import { translateRequest, needsTranslation } from "../translate/index.js";
import { FORMATS, detectFormatByEndpoint } from "../translate/formats.js";
import { detectFormat } from "../translate/deps/detectFormat.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { STREAM_IDLE_TIMEOUT_MS, UPSTREAM_429_MEMO_MS } from "../limits.mjs";

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

/**
 * Which provider a node is, for the param-support table.
 *
 * An explicit `data.provider` wins; otherwise the node's prefix, which is the user's own name
 * for the upstream and is usually the provider ("bai", "github"). A rule that needs extra
 * setup before it can fire is a rule that stays dead — which is what happened to this whole
 * table while nothing called it.
 */
function providerKeyFor(node) {
  return String(node?.data?.provider || node?.prefix || "").toLowerCase();
}

function targetFormatForNode(node, model) {
  if (node.apiType === "anthropic") return FORMATS.CLAUDE;
  if (node.apiType === "responses") return FORMATS.OPENAI_RESPONSES;
  // opencode's muse-spark free models speak the Responses dialect on /zen/v1/responses —
  // decided per MODEL, not per node (its apiType stays "openai" for the rest of the list).
  if (node.data?.executor === "opencode" && opencodeSpeaksResponses(model)) return FORMATS.OPENAI_RESPONSES;
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

    // A combo request announces itself, with the plan the strategy produced. Without this
    // line the console cannot answer "which member served this, and why that one?" — and a
    // combo correctly stored as `fallback` is then indistinguishable from broken rotation,
    // which is exactly how it reads when the first member always wins.
    const combo = route.kind === "combo" ? describeCombo(repos, route, ordered, routes, candidates) : null;

    if (candidates.length === 0) {
      const expiries = routes
        .filter((r) => r.kind === "node")
        .map((r) => repos.breakers.get(`node:${r.node.id}`))
        .filter((b) => b && b.openUntil)
        .map((b) => Date.parse(b.openUntil))
        .filter((t) => Number.isFinite(t));
      const retryAfterMs = expiries.length ? Math.max(0, Math.max(...expiries) - Date.now()) : null;
      // The combo's members and the reason each was skipped belong in the error: "all routes
      // have open breakers" names nothing the operator can act on.
      const detail = combo
        ? `every member of combo "${combo.name}" is unavailable${combo.skipped.length ? ` (${combo.skipped.map((s) => `${s.model}: ${s.why}`).join("; ")})` : ""}`
        : "all routes have open breakers";
      if (combo) log.warn("COMBO", `${combo.name} ← all ${combo.of ?? combo.order.length} member(s) unavailable`, { ...combo, retryAfterMs });
      return json(res, 503, { error: { message: "all_unavailable", detail, retryAfterMs } });
    }

    // Announce the plan before dispatch — the members in the order the strategy produced, and
    // what was left out. The outcome lands on the request line once a member serves it.
    if (combo) log.info("COMBO", combo.line, { combo: combo.name, strategy: combo.strategy, stickyLimit: combo.stickyLimit, order: combo.order, skipped: combo.skipped });

    // How many upstream attempts this request needed. 1 is the healthy path; higher
    // means rotation or combo fallback earned its keep, which is invisible in a
    // successful response otherwise.
    let attempts = 0;

    // Which try served this request, in the order the strategy produced — 1 means the first
    // member we tried answered, higher means it fell through. (Rotation shows up in `order`
    // and in which member served, not here: under round-robin every request starts at a
    // different member, so the serving attempt is 1 either way.)
    let dispatchIndex = 0;
    const comboFor = (r) =>
      combo
        ? {
            name: combo.name,
            strategy: combo.strategy,
            of: combo.of,
            order: combo.order,
            skipped: combo.skipped,
            member: `${r.node.prefix}/${r.model}`,
            attempt: dispatchIndex,
          }
        : null;

    // Round-robin per request within a node, then combo-fallback across nodes. The key
    // loop lives inside the node loop: a key problem rotates to the node's next key, a
    // node problem advances to the next node — the two failure domains must not blur.
    const recent429 = new Map(); // nodeId -> Set of connectionIds that 429'd on this model
    for (const r of candidates) {
      dispatchIndex++;
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

      // One-shot optional-param retry, per route (see the client-verdict branch below):
      // some providers reject a request ONLY because of an optional reasoning param and answer
      // with an opaque body that names neither the param nor a machine-readable reason — b.ai's
      // MaaS front ("rejected by an internal MaaS component", code 400001) does exactly this for
      // reasoning_effort values that other accounts of the same provider accept, so no static
      // STRIP_RULES entry can be right for everyone. When such a 400 arrives while the request
      // still carries optional reasoning params, the same connection is retried ONCE without them
      // (re-queued below), and the log names what was dropped.
      //
      // Per route, not per request: the opinion being probed belongs to an upstream ACCOUNT, so a
      // second member is entitled to its own probe (and its own answer) rather than inheriting the
      // first member's. Keys of one node are the same connection family, so one probe covers them.
      const OPTIONAL_REASONING_PARAMS = ["reasoning_effort", "reasoning", "thinking"];
      let paramRetryUsed = false;
      const keyQueue = keys.map((c) => ({ connection: c, body: null })); // body=null -> build from request

      // Index loop over a growable queue: a requeued param-retry is appended and will be
      // reached after the current pass's remaining keys.
      for (let qi = 0; qi < keyQueue.length; qi++) {
        const { connection, body: retryBody } = keyQueue[qi];
        // Which proxy this attempt egresses through: the key's own pool when it has one,
        // else the provider's rotation. Resolved per attempt so a rotation to another
        // key can also rotate its proxy.
        const proxy = resolveNodeProxy(repos, r.node, connection, { settings });
        const targetFormat = targetFormatForNode(r.node, r.model);
        const translate = needsTranslation(sourceFormat, targetFormat);

        // `sourceBody` is what the caller sent — and on a retry, that same body with the optional
        // reasoning params removed. Everything downstream builds from it, so a retry is a request
        // the caller could have sent and translation treats it like any other. Dropping the param
        // from the TRANSLATED body instead would drop it from nothing: translation re-derives the
        // provider-native thinking field from the source, so the retry would resend the exact
        // request that just failed while the log reported a successful drop.
        const sourceBody = retryBody ?? body;
        let outbound = { ...sourceBody, model: r.model };
        let toolNameMap = null;
        let customToolNames = null;
        if (translate) {
          if (!stream && (targetFormat === FORMATS.CLAUDE || targetFormat === FORMATS.OPENAI_RESPONSES)) {
            lastError = { status: 501, errorCode: "not_implemented", message: "non-streaming + translation lands in P1.6b" };
            nodeDied = true;
            break;
          }
          try {
            outbound = translateRequest(sourceFormat, targetFormat, r.model, structuredClone(sourceBody), stream, {}, null, null, [], null, null);
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
          // info, not debug: a hit is rare (only compressible tool output gets this far) and it
          // is money saved — the one line an operator should see in the DEFAULT capture. The
          // "turn on debug to trace" rule stays for traces; this is a result, not a trace.
          if (rtkStats?.hits?.length) log.info("RTK", formatRtkLog(rtkStats));
        }

        // Params this provider rejects are dropped here — the final body, after translation,
        // before dispatch. Same slot 9Router calls its final-body stage, and it runs on the
        // passthrough path too, which is the one a client talking OpenAI to an OpenAI-shaped
        // provider actually uses. This table existed and was never called from anywhere, so
        // every rule in it was dead: one unsupported client field reached its provider,
        // 400'd, and (before the verdict above) took the node's breaker with it.
        //
        // Anything it changes is logged. A policy that edits a caller's request invisibly is a
        // policy nobody can audit — and the first rule added to this table was wrong for the
        // provider it named, which only showed up because the effect was measured by hand.
        const paramChanges = stripUnsupportedParams(providerKeyFor(r.node), r.model, outbound);
        if (paramChanges.length > 0) {
          log.info("PARAM", `${r.node.prefix} does not accept ${paramChanges.map((c) => c.param).join(", ")} — adjusted before dispatch`, {
            provider: providerKeyFor(r.node), model: r.model, changes: paramChanges,
          });
        }

        // One node can name its own executor: opencode's endpoint is composed per request
        // (core/executors/opencode.mjs); every other node keeps the default wire.
        const Executor = r.node.data?.executor === "opencode" ? OpenCodeExecutor : DefaultExecutor;
        const executor = new Executor(r.node, connection, { proxy });
        // Per-node stall budget; 0 disables the watchdog.
        const idleTimeoutMs = r.node.data?.streamIdleTimeoutMs ?? globalIdleTimeoutMs;
        attempts++;
        const result = await executor.execute({
          model: r.model, body: outbound, stream, signal: clientAbort.signal, log,
          // When the downstream client IS the opencode app it carries its own session,
          // project and UA — they pass through; anyone else gets the node's stable session.
          clientHeaders: req.headers,
        });

        if (!result.ok) {
          // A client walking away (or a client-side timeout) says nothing about the
          // provider's health. Counting it degrades a perfectly good node and, after
          // three, opens its breaker — so aborts never touch the breaker.
          if (result.errorCode === "client_aborted") {
            log.info("CHAT", `client aborted ${r.node.prefix}`, { afterMs: Date.now() - t0 });
            lastError = result;
            return json(res, 499, { error: { message: "client_aborted", detail: "client aborted the request" } });
          }

          // A failure of OUR OWN egress path says nothing about the provider OR the key: the
          // exits were unreachable, rejected our credentials, or are all sitting in a
          // cooldown. Charge it to neither — otherwise three dead proxies open a healthy
          // node's breaker, and every key gets cooled against a provider that is fine.
          if (result.errorCode === "proxy_failed" || result.errorCode === "proxy_exhausted") {
            lastError = result;
            log.warn("CHAT", `node ${r.node.prefix}: ${result.errorCode} — ${result.message}`, { retryAfterMs: result.retryAfterMs ?? null });
            // A provider-level binding covers every key of this node, so rotating keys against
            // it only multiplies the failure by the key count — advance to the next node. A
            // KEY-level pool belongs to one key, and the next key may be behind a working fleet.
            if (result.proxySource === "provider") {
              nodeDied = true;
              break;
            }
            continue;
          }

          // A request-shaped rejection (400/413/422) belongs to the caller, not to the
          // provider's health. Charging it to the breaker is what turns one unsupported field
          // into an outage: three requests with `reasoning_effort: "medium"` opened b.ai's
          // node breaker, and every later request — for every model on it — came back 503
          // all_unavailable. Advancing without recording also keeps the useful case: providers
          // disagree about which params they accept, so the next route may serve it.
          if (classifyConnectionError(result, { connection, recent429: null }).verdict === "client") {
            lastError = result;
            log.warn("CHAT", `node ${r.node.prefix} rejected the request (${result.status}) — trying the next route, no health recorded`, {
              errorCode: result.errorCode,
              combo: combo?.name ?? null,
              detail: String(result.message || "").slice(0, 160),
            });
            // Opaque 400 while optional reasoning params are still aboard: the static param
            // table could not have predicted this provider's opinion (it is account-scoped, see
            // the b.ai note in paramSupport.js), so learn it live — one retry without them, on
            // this same connection. If the retry also 400s, fall through to the normal
            // next-route behavior; nothing is charged to health either way.
            const detailLower = String(result.message || "").toLowerCase();
            // Named as the caller sent them: the retry body is source-shaped, so the params it
            // drops are the caller's own fields, whatever shape the target format needed them in.
            const strippable = OPTIONAL_REASONING_PARAMS.filter((k) => sourceBody[k] !== undefined);
            // Only OPAQUE rejections qualify: when the body names the rejected param
            // ("MaaS reject: reasoning_effort medium"), the caller can fix it — retrying would
            // mask a real diagnosis behind a silent rewrite.
            const opaque = strippable.every((k) => !detailLower.includes(k));
            if (!paramRetryUsed && opaque && strippable.length > 0 && result.status === 400) {
              paramRetryUsed = true;
              const strippedSource = { ...sourceBody };
              const dropped = {};
              for (const k of strippable) { dropped[k] = strippedSource[k]; delete strippedSource[k]; }
              log.warn("CHAT", `node ${r.node.prefix} answered 400 with an opaque body — retrying this connection once without optional reasoning params`, {
                dropped, detail: String(result.message || "").slice(0, 200),
              });
              keyQueue.push({ connection, body: strippedSource }); // requeued: reached after the remaining keys
              continue; // next qi — the requeued attempt runs after the queue's remaining keys
            }
            nodeDied = true;
            break;
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
            pool: proxy?.poolName ?? null,
            combo: comboFor(r),
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
        const usageEventId = recordUsage(repos, log, r, connection, body.model, { status: "ok", usage, durationMs: Date.now() - t0, apiKeyId, attempts, pool: proxy?.poolName ?? null, combo: comboFor(r) });
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

function recordUsage(repos, log, route, connection, clientModel, { status, usage, durationMs, apiKeyId, attempts = 1, pool = null, combo = null }) {
  // Metered nodes carry pricing config; unmetered ones record null and can never
  // consume budget. Latency memory is fed here so routing has one write path.
  const costUsd = costOf(route.node, { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens });
  if (Number.isFinite(costUsd)) addSpend(costUsd);
  if (status === "ok" && Number.isFinite(usage.ttftMs)) observeTtft(route.node.id, usage.ttftMs);

  const event = repos.usage.record({
    nodeId: route.node.id,
    connectionId: connection.id ?? null,
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
  log.info("REQ", combo ? `${combo.name} → ${combo.member} ← ${status} · try ${combo.attempt}/${combo.of}` : `${route.node.prefix} ← ${status}`, {
    requestId: event.id,
    model: clientModel,
    nodeId: route.node.id,
    connectionId: connection.id ?? null,
    key: `${connection.name} (${maskKey(connection.credentials?.apiKey)})`,
    // How a combo request was served: which member, where it sat in the strategy's order, and
    // what the strategy skipped. Without these the line cannot tell a correct `fallback`
    // (member 1 by design) from a broken `round-robin` (member 1 every time).
    ...(combo
      ? { combo: combo.name, strategy: combo.strategy, member: combo.member, attempt: combo.attempt, of: combo.of, order: combo.order, skipped: combo.skipped }
      : {}),
    // Which proxy egressed this request — the same question the key answers, for the
    // other half of "how did this request leave the building".
    pool,
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
