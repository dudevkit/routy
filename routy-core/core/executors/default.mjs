// routy default executor — one per node; speaks openai chat (apiType "chat") and
// openai-responses ("responses"). Ported from upstream executors/{base,default}.js
// with modernizations: stringify-once, a pooled per-origin undici dispatcher
// (P4: the built-in fetch's default dispatcher cost ~15ms/request — see pool.mjs),
// AbortSignal.any connect timeout, structured error results.
// Retry defaults = upstream parity (runtimeConfig.js:78-84): 502→3×3s, 503→3×2s,
// 429→no retry (caller falls back to next connection/node), Retry-After honored.
import { getDispatcher, undiciFetch } from "./pool.mjs";
import { getProxyAgent } from "../proxy.mjs";
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
};
export const CONNECT_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DefaultExecutor {
  /**
   * @param {object} node        provider_nodes row (apiType, baseUrl, data)
   * @param {object} connection  connections row (credentials.apiKey)
   * @param {object} [opts]
   * @param {object} [opts.proxy] resolved proxy ({ url, strict, poolId, poolName }), or
   *                              null for a direct connection. Resolved by the caller,
   *                              which is where repos is in scope.
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
  #dispatcher(proxy) {
    if (!proxy?.url) return getDispatcher(this.node);
    return getProxyAgent(proxy.url) || getDispatcher(this.node);
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

  /**
   * A proxy-level failure — unreachable, or rejecting our credentials. Retry directly
   * when the pool allows it, otherwise fail with a message that NAMES the proxy: "proxy
   * railway-1 failed: connect ECONNREFUSED" is actionable, "network_error" is not, and
   * a silent direct request would leak the address the proxy exists to hide.
   */
  #onProxyFailure(proxy, detail, log) {
    if (proxy.strict === false) {
      log?.warn?.("PROXY", `pool "${proxy.poolName ?? proxy.poolId}" failed — retrying directly (strict is off)`, {
        node: this.node.prefix, error: String(detail).slice(0, 160),
      });
      return { retryDirect: true };
    }
    return {
      error: {
        ok: false,
        status: 502,
        errorCode: "proxy_failed",
        retryAfterMs: null,
        message: `proxy ${proxy.poolName ?? proxy.poolId} failed: ${String(detail).slice(0, 200)}`,
      },
    };
  }

  /**
   * Execute a chat request against the node.
   * @returns {Promise<{ok:true, response: Response, url: string}> |
   *           {ok:false, status: number, errorCode: string, retryAfterMs: number|null, message: string}}
   */
  async execute({ model, body, stream, signal, log = null }) {
    const url = this.buildUrl();
    // A proxied request already failed through the proxy is retried directly once,
    // unless the pool is strict — a silent direct request would leak the caller's real
    // address, which is the thing the proxy exists to avoid.
    let proxy = this.proxy;
    let proxyTried = false;
    // stringify ONCE per logical request (upstream re-stringified per retry attempt)
    const bodyStr = JSON.stringify({ ...body, model, stream });

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
        pool: proxy?.poolName ?? null,
      });
      try {
        const response = await undiciFetch(url, {
          method: "POST",
          headers: this.buildHeaders(),
          body: bodyStr,
          signal: merged,
          dispatcher: this.#dispatcher(proxy),
        });
        clearTimeout(timer);
        log?.debug?.("UPSTREAM", `← ${response.status} ${this.node.prefix}${attempt}`, {
          status: response.status,
          contentType: response.headers?.get?.("content-type") ?? null,
          ttfbMs: Date.now() - t0,
        });

        if (response.ok) return { ok: true, response, url, abort: (reason) => controller.abort(reason) };

        // 407 is the proxy telling us the credentials are wrong — a proxy failure, not a
        // provider one, and not something worth retrying three times with a delay. A 5xx
        // is left to the provider: a working proxy can legitimately carry one.
        if (proxy && !proxyTried && response.status === 407) {
          proxyTried = true;
          const outcome = this.#onProxyFailure(proxy, "rejected the credentials (HTTP 407)", log);
          if (outcome.retryDirect) { proxy = null; continue; }
          return outcome.error;
        }

        const err = await this.#classify(response, log);
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

        // The proxy itself is the suspect: a connect-level failure through a proxy says
        // nothing about the provider, so it gets the strict/fallback treatment rather
        // than being charged to the node's health.
        if (proxy && !proxyTried && !isTimeout) {
          proxyTried = true;
          const outcome = this.#onProxyFailure(proxy, message, log);
          if (outcome.retryDirect) { proxy = null; continue; }
          return outcome.error;
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
