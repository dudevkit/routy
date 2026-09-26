// routy default executor — one per node; speaks openai chat (apiType "chat") and
// openai-responses ("responses"). Ported from upstream executors/{base,default}.js
// with modernizations: stringify-once, a pooled per-origin undici dispatcher
// (P4: the built-in fetch's default dispatcher cost ~15ms/request — see pool.mjs),
// AbortSignal.any connect timeout, structured error results.
// Retry defaults = upstream parity (runtimeConfig.js:78-84): 502→3×3s, 503→3×2s,
// 429→no retry (caller falls back to next connection/node), Retry-After honored.
//
// A proxied request additionally FAILS OVER: the plan carries an ordered list of exits,
// and one that cannot serve hands the request to the next instead of failing outright.
// Only failures that are evidence about the address rotate (see core/proxy.mjs) — a 5xx
// is the provider's, and rotating exits over it would burn the fleet for nothing.
import { getDispatcher, undiciFetch } from "./pool.mjs";
import { classifyProxyFailure, getProxyAgent } from "../proxy.mjs";
import { PROXY_MAX_ATTEMPTS, PROXY_MAX_RATE_LIMIT_ATTEMPTS } from "../limits.mjs";
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
};
export const CONNECT_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A bound proxy that cannot serve at all (no exits, or every exit cooling). */
function proxyUnavailable(plan) {
  return {
    ok: false,
    status: plan.retryAfterMs ? 429 : 502,
    errorCode: plan.retryAfterMs ? "proxy_exhausted" : "proxy_failed",
    retryAfterMs: plan.retryAfterMs ?? null,
    // Whether this binding came from the provider (every key of the node is behind it) or
    // from one key's own override. The caller uses it to decide whether rotating keys can
    // possibly help.
    proxySource: plan.source ?? null,
    message: `proxy "${plan.target}": ${plan.reason || "no usable exits"}`,
  };
}

/** Every exit failed. `strict` decides whether the caller hears about it or goes direct. */
function proxyFailed(plan, failures) {
  const rateLimited = failures.length > 0 && failures.every((f) => f.rotate.kind === "rate_limit");
  const detail = [...new Set(failures.map((f) => f.rotate.detail).filter(Boolean))].slice(-3).join(" · ");
  return {
    ok: false,
    // A fleet that answered 429 everywhere is a rate-limit answer, not a gateway failure:
    // saying so lets the caller honour Retry-After instead of hammering the next provider.
    status: rateLimited ? 429 : 502,
    errorCode: rateLimited ? "proxy_exhausted" : "proxy_failed",
    retryAfterMs: rateLimited ? (failures[failures.length - 1]?.rotate?.retryAfterMs ?? null) : null,
    proxySource: plan.source ?? null,
    message: `proxy "${plan.target}": tried ${failures.length} exit(s) — ${detail || "no detail"} (strict: not retrying directly)`,
  };
}

export class DefaultExecutor {
  /**
   * @param {object} node        provider_nodes row (apiType, baseUrl, data)
   * @param {object} connection  connections row (credentials.apiKey)
   * @param {object} [opts]
   * @param {object} [opts.proxy] resolved proxy plan ({ candidates: [{ url, poolName,
   *                              strict, entryId }], directAllowed, onFailed, onSucceeded }),
   *                              or null for a direct connection. Resolved by the caller,
   *                              which is where repos is in scope — the executor holds no
   *                              repos and never writes health itself.
   */
  constructor(node, connection, { proxy = null } = {}) {
    this.node = node;
    this.connection = connection;
    this.proxy = proxy;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...(node?.data?.retry || {}) };
    this.connectTimeoutMs = node?.data?.timeoutMs || CONNECT_TIMEOUT_MS;
  }

  /**
   * The dispatcher for one attempt. A proxy replaces the per-origin agent entirely:
   * ProxyAgent owns its own connection pool to the proxy, so the two cannot combine.
   */
  #dispatcher(exit) {
    if (!exit?.url) return getDispatcher(this.node);
    return getProxyAgent(exit.url) || getDispatcher(this.node);
  }

  buildUrl() {
    const base = (this.node.baseUrl || "").replace(/\/+$/, "");
    if (this.node.apiType === "responses") return `${base}/responses`;
    return `${base}/chat/completions`;
  }

  buildHeaders() {
    const key = this.connection?.credentials?.apiKey;
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  /** A failure that belongs to the exit, packaged so the orchestrator can rotate it. */
  #exitFailure(exit, rotate) {
    return {
      ok: false,
      status: rotate.kind === "rate_limit" ? 429 : 502,
      errorCode: "proxy_failed",
      retryAfterMs: rotate.retryAfterMs ?? null,
      message: `proxy ${exit.poolName}: ${rotate.detail}`,
      rotate,
    };
  }

  /**
   * Execute a chat request against the node.
   * @returns {Promise<{ok:true, response: Response, url: string}> |
   *           {ok:false, status: number, errorCode: string, retryAfterMs: number|null, message: string}}
   */
  async execute({ model, body, stream, signal, log = null }) {
    const url = this.buildUrl();
    const plan = this.proxy;
    // stringify ONCE per logical request (upstream re-stringified per retry attempt)
    const bodyStr = JSON.stringify({ ...body, model, stream });

    // A bound proxy that cannot serve fails the request rather than quietly going direct: a
    // binding is a routing decision, and silently dropping it is the one outcome a proxy
    // exists to prevent.
    if (plan && plan.candidates.length === 0) return proxyUnavailable(plan);

    const exits = plan ? plan.candidates : [null]; // null = the direct connection
    const failures = [];
    let rateLimited = 0;

    for (let i = 0; i < exits.length && i < PROXY_MAX_ATTEMPTS; i++) {
      const exit = exits[i];
      const result = await this.#attempt({ url, exit, bodyStr, model, stream, signal, log });
      if (result.ok) {
        plan?.onSucceeded?.(exit);
        return result;
      }
      // A provider failure is not the exit's fault: hand it back untouched so the caller's
      // own retry and credential-fallback rules apply exactly as they would without a proxy.
      if (!result.rotate) return result;

      failures.push({ exit, rotate: result.rotate });
      plan?.onFailed?.(exit, result.rotate);
      if (result.rotate.kind === "rate_limit") rateLimited++;

      const left = exits.length - i - 1;
      log?.warn?.("PROXY", `exit ${exit.poolName} ${result.rotate.kind} failure — ${left ? `${left} exit(s) left` : "no exits left"}`, {
        node: this.node.prefix,
        entryId: exit.entryId,
        detail: String(result.rotate.detail).slice(0, 140),
      });
      // Rotating after a rate-limit failure bets that the limit is per address. The cap is
      // what stops that bet from costing one request per exit when it is per account.
      if (rateLimited >= PROXY_MAX_RATE_LIMIT_ATTEMPTS) break;
    }

    if (!plan) return failures.length ? proxyFailed({ target: "direct" }, failures) : { ok: false, status: 502, errorCode: "network_error", retryAfterMs: null, message: "no attempt was made" };
    if (!plan.directAllowed) return proxyFailed(plan, failures);

    log?.warn?.("PROXY", `all ${failures.length} exit(s) of "${plan.target}" failed — retrying directly (strict is off)`, { node: this.node.prefix });
    return this.#attempt({ url, exit: null, bodyStr, model, stream, signal, log });
  }

  /**
   * One upstream attempt path, bound to one exit (or none), including its own retry budget.
   * `rotate` on the result means "this failure was the exit's, try another" — it is only
   * ever set when an exit is in use, so a direct connection behaves exactly as before.
   */
  async #attempt({ url, exit, bodyStr, model, stream, signal, log }) {
    const perUrl = {};
    for (let attemptPhase = 0; ; attemptPhase++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("connect timeout")), this.connectTimeoutMs);
      const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const t0 = Date.now();
      // Every upstream attempt is traceable: what we sent, what came back, how long
      // it took, and whether we retried. `debug` level — flip the log level to see it.
      const attempt = attemptPhase === 0 ? "" : ` (retry ${attemptPhase})`;
      log?.debug?.("UPSTREAM", `→ POST ${this.node.prefix} ${url}`, {
        model, stream, attempt: attemptPhase, bytes: bodyStr.length, timeoutMs: this.connectTimeoutMs,
        pool: exit?.poolName ?? null, entry: exit?.entryId ?? null,
      });
      try {
        const response = await undiciFetch(url, {
          method: "POST",
          headers: this.buildHeaders(),
          body: bodyStr,
          signal: merged,
          dispatcher: this.#dispatcher(exit),
        });
        clearTimeout(timer);
        log?.debug?.("UPSTREAM", `← ${response.status} ${this.node.prefix}${attempt}`, {
          status: response.status,
          contentType: response.headers?.get?.("content-type") ?? null,
          ttfbMs: Date.now() - t0,
        });

        if (response.ok) return { ok: true, response, url, abort: (reason) => controller.abort(reason) };

        // 407 is the exit telling us its credentials are wrong — evidence about the exit,
        // not the provider, and not worth three delayed retries.
        if (exit && response.status === 407) {
          return this.#exitFailure(exit, {
            kind: "auth",
            reason: "rejected our credentials (407)",
            detail: "rejected our credentials (HTTP 407)",
          });
        }

        const err = await this.#classify(response, log);
        // A 429 on a proxied request is the signature of a per-address limit — the thing a
        // fleet exists to spread across. A body naming the provider is the exception: no
        // address can fix it, so it is reported like any other upstream failure.
        if (exit && err.status === 429 && classifyProxyFailure(err) === "exit") {
          return this.#exitFailure(exit, {
            kind: "rate_limit",
            reason: "rate limited this address",
            detail: `rate limited (HTTP 429)${err.message && err.message !== "HTTP 429" ? `: ${String(err.message).slice(0, 120)}` : ""}`,
            retryAfterMs: err.retryAfterMs,
          });
        }

        if (await this.#maybeRetry(err, perUrl, log)) continue;
        return err;
      } catch (error) {
        clearTimeout(timer);
        if (signal?.aborted) {
          log?.debug?.("UPSTREAM", `✖ ${this.node.prefix} aborted by the client`, { afterMs: Date.now() - t0 });
          return { ok: false, status: 499, errorCode: "client_aborted", retryAfterMs: null, message: "client aborted" };
        }
        const isTimeout = controller.signal.aborted;
        // undici reports "fetch failed" and hides the reason one level down; the cause is
        // the only part that tells the user what to fix (ECONNREFUSED, ENOTFOUND, proxy
        // auth). Same treatment the proxy health check gives it.
        const cause = error?.cause;
        const message = isTimeout
          ? "connect timeout"
          : [String(error?.message || error), cause?.code, cause?.message].filter(Boolean).join(" · ");

        // A thrown fetch error through a proxy means the proxy path broke before the
        // provider answered — the exit could not be reached, or refused the CONNECT. Our own
        // timeout is excluded: it may equally be a slow provider, and rotating would
        // multiply the wait rather than shorten it.
        if (exit && !isTimeout) {
          return this.#exitFailure(exit, { kind: "connect", reason: "could not be reached", detail: message });
        }

        log?.debug?.("UPSTREAM", `✖ ${this.node.prefix} ${message}`, { afterMs: Date.now() - t0, connectTimeout: isTimeout });
        const err = {
          ok: false,
          status: 502,
          errorCode: isTimeout ? "connect_timeout" : "network_error",
          retryAfterMs: null,
          message,
        };
        // connect timeout already burned the full timeout budget — no retry, fail fast to fallback
        if (!isTimeout && (await this.#maybeRetry(err, perUrl, log))) continue;
        return err;
      }
    }
  }

  async #classify(response, log) {
    const status = response.status;
    let message = `HTTP ${status}`;
    let retryAfterMs = null;
    const rah = response.headers?.get?.("retry-after");
    if (rah) {
      const secs = Number(rah);
      retryAfterMs = Number.isFinite(secs) ? secs * 1000 : (Date.parse(rah) - Date.now() || null);
    }
    try {
      const text = await response.text();
      if (text) message = text.slice(0, 500);
    } catch { /* body unreadable — keep generic message */ }
    log?.debug?.("UPSTREAM", `✖ ${this.node.prefix} error ${status}`, { status, retryAfterMs, body: message.slice(0, 200) });
    const errorCode =
      status === 401 || status === 403 ? "auth_error"
      : status === 429 ? "rate_limited"
      : status >= 500 ? "upstream_error"
      : "upstream_error";
    // Body consumed — response is no longer usable for streaming on error paths.
    return { ok: false, status, errorCode, retryAfterMs, message };
  }

  async #maybeRetry(err, perUrl, log) {
    const cfg = this.retryConfig[err.status];
    if (!cfg) return false;
    const attempts = cfg.attempts ?? 0;
    const used = perUrl[err.status] || 0;
    if (used >= attempts) return false;
    perUrl[err.status] = used + 1;
    let delayMs = cfg.delayMs ?? 0;
    if (err.status === 429 && err.retryAfterMs) delayMs = err.retryAfterMs; // honor Retry-After even though 429 default = 0 attempts
    if (delayMs > 0) await sleep(delayMs);
    log?.debug?.("UPSTREAM", `↻ ${this.node.prefix} retry ${used + 1}/${attempts} after ${delayMs}ms`, { status: err.status, errorCode: err.errorCode, delayMs });
    return true;
  }
}
