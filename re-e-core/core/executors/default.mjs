// RE-E default executor — one per node; speaks openai chat (apiType "chat") and
// openai-responses ("responses"). Ported from upstream executors/{base,default}.js
// with modernizations: stringify-once, global fetch (builtin keep-alive pool),
// AbortSignal.any connect timeout, structured error results.
// Retry defaults = upstream parity (runtimeConfig.js:78-84): 502→3×3s, 503→3×2s,
// 429→no retry (caller falls back to next connection/node), Retry-After honored.
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
   */
  constructor(node, connection) {
    this.node = node;
    this.connection = connection;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...(node?.data?.retry || {}) };
    this.connectTimeoutMs = node?.data?.timeoutMs || CONNECT_TIMEOUT_MS;
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
   * Execute a chat request against the node.
   * @returns {Promise<{ok:true, response: Response, url: string}> |
   *           {ok:false, status: number, errorCode: string, retryAfterMs: number|null, message: string}}
   */
  async execute({ model, body, stream, signal, log = null }) {
    const url = this.buildUrl();
    // stringify ONCE per logical request (upstream re-stringified per retry attempt)
    const bodyStr = JSON.stringify({ ...body, model, stream });

    const perUrl = {};
    for (let attemptPhase = 0; ; attemptPhase++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("connect timeout")), this.connectTimeoutMs);
      const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const t0 = Date.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: this.buildHeaders(),
          body: bodyStr,
          signal: merged,
        });
        clearTimeout(timer);
        log?.debug?.("FETCH", `${this.node.prefix} ← ${response.status} ttft=${Date.now() - t0}ms`);

        if (response.ok) return { ok: true, response, url, abort: (reason) => controller.abort(reason) };

        const err = await this.#classify(response, log);
        if (await this.#maybeRetry(err, perUrl, log)) continue;
        return err;
      } catch (error) {
        clearTimeout(timer);
        if (signal?.aborted) {
          return { ok: false, status: 499, errorCode: "client_aborted", retryAfterMs: null, message: "client aborted" };
        }
        const isTimeout = controller.signal.aborted;
        const message = isTimeout ? "connect timeout" : String(error?.message || error);
        log?.debug?.("FETCH", `${this.node.prefix} ✖ ${message}`);
        const err = { ok: false, status: 502, errorCode: isTimeout ? "connect_timeout" : "network_error", retryAfterMs: null, message };
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
    log?.debug?.("FETCH", `${this.node.prefix} error ${status}: ${message.slice(0, 120)}`);
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
    log?.debug?.("RETRY", `${this.node.prefix} status ${err.status} retry ${used + 1}/${attempts} after ${delayMs}ms`);
    return true;
  }
}
