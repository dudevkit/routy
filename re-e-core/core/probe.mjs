// RE-E probes — diagnostics, never traffic.
//
// A probe answers "does this key work?" / "does this model actually serve?" and
// records the answer on the key or model row. Probes deliberately do NOT:
//   - write usage_events (a 1-token ping must not move the error rate or budget)
//   - touch the budget counter
//   - call recordFailure/recordSuccess (testing a bad key must never mark a
//     healthy provider as down — the test would cause the outage it detects)
//
// Three kinds, all sharing the same error shaping:
//   probeNode   GET  <baseUrl>/models                        — node-level reachability
//   probeKey    GET  <baseUrl>/models      with ONE key      — is this key valid?
//   probeModel  POST <baseUrl>/chat/completions  stream      — does this model serve?
import { getDispatcher, undiciFetch } from "./executors/pool.mjs";

const DEFAULT_TIMEOUT_MS = 5000;
const MODEL_PROBE_TIMEOUT_MS = 20_000;

const trimBase = (baseUrl) => String(baseUrl || "").replace(/\/+$/, "");

function shapeError(err) {
  return String(err?.cause?.message || err?.message || err).slice(0, 200);
}

/**
 * Probe a node's model list. Returns { ok, latencyMs, modelCount, models } on
 * success, { ok:false, latencyMs, error } otherwise. An endpoint that answers
 * without a JSON body still counts as reachable (modelCount 0).
 */
export async function probeNode(baseUrl, apiKey = null, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${trimBase(baseUrl)}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    let modelCount = 0;
    let models = [];
    try {
      const body = await res.json();
      if (Array.isArray(body?.data)) {
        modelCount = body.data.length;
        models = body.data.map((m) => (typeof m === "string" ? m : m?.id || "")).filter(Boolean);
      }
    } catch { /* non-JSON models endpoint — probe still ok */ }
    return { ok: true, latencyMs, modelCount, models };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: shapeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one API key against a node's base URL. */
export async function probeKey(node, connection, opts = {}) {
  const apiKey = connection?.credentials?.apiKey ?? null;
  return probeNode(node?.baseUrl, apiKey, opts);
}

/**
 * Prove a single model id actually serves: a real (tiny) streamed completion.
 * `max_tokens: 1` keeps it to a token or two; we stop at the first content frame,
 * which is also the TTFT.
 *
 * Uses the node's pooled dispatcher so the probe travels the same connection path
 * the proxy uses, but bypasses breakers and usage entirely.
 */
export async function probeModel(node, model, connection = null, { timeoutMs = MODEL_PROBE_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const apiKey = connection?.credentials?.apiKey ?? null;
  const url = node?.apiType === "responses"
    ? `${trimBase(node.baseUrl)}/responses`
    : `${trimBase(node.baseUrl)}/chat/completions`;
  const payload = JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  });

  try {
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: payload,
      signal: controller.signal,
      dispatcher: getDispatcher(node),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.text()).slice(0, 200) || detail; } catch { /* keep status */ }
      return { ok: false, ttftMs: null, latencyMs: Date.now() - t0, error: detail };
    }

    // Read until the first frame that carries content, then stop — no need to
    // drain the rest of a one-token response.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawAnyFrame = false;
    let ttftMs = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          const data = frame.startsWith("data:") ? frame.slice(5).trim() : "";
          if (!data) continue;
          sawAnyFrame = true;
          if (data === "[DONE]") break;
          try {
            const obj = JSON.parse(data);
            if (obj?.error) return { ok: false, ttftMs: null, latencyMs: Date.now() - t0, error: JSON.stringify(obj.error).slice(0, 200) };
            const delta = obj?.choices?.[0]?.delta;
            const text = typeof delta?.content === "string" ? delta.content : "";
            const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
            if (text || reasoning) { ttftMs = Date.now() - t0; break; }
          } catch { /* non-JSON frame — keep scanning */ }
        }
        if (ttftMs !== null) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* already gone */ }
    }

    if (ttftMs === null && sawAnyFrame) {
      // the stream opened and spoke, but produced no content token (e.g. an
      // immediate stop with max_tokens 1) — still a healthy model
      ttftMs = Date.now() - t0;
    }
    if (ttftMs === null) return { ok: false, ttftMs: null, latencyMs: Date.now() - t0, error: "upstream returned an empty stream" };
    return { ok: true, ttftMs, latencyMs: Date.now() - t0, error: null };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return { ok: false, ttftMs: null, latencyMs: Date.now() - t0, error: aborted ? `timeout after ${timeoutMs}ms` : shapeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
