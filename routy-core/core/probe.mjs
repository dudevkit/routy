// routy probes — diagnostics, never traffic.
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
import { randomUUID } from "node:crypto";
import diagnostics_channel from "node:diagnostics_channel";
import { getDispatcher, originOf, undiciFetch } from "./executors/pool.mjs";
import { getProxyAgent, primaryProxyUrl } from "./proxy.mjs";

/**
 * Socket-level truth for a probe, via undici's diagnostics channels.
 *
 * "no response within 45000ms (stage: connect)" cannot be acted on: it does not
 * say whether the socket connected, whether the request was written, or whether
 * the provider simply never answered. Those are three different problems. The
 * channels expose them below the fetch abstraction, so a probe reports a
 * timeline — created / connected / headers — and names the stage it actually
 * died at. Measured against a real free tier: the socket connected in 88ms and
 * the headers never came, which is a provider-side stall, not a connect failure.
 */
const PROBE_ID_HEADER = "x-ree-probe";
const inFlight = new Map();
let observing = false;

const headerValue = (headers, name) => {
  if (!Array.isArray(headers)) return null;
  for (let i = 0; i < headers.length; i += 2) if (headers[i] === name) return headers[i + 1];
  return null;
};

function observeUpstream() {
  if (observing) return;
  observing = true;
  const mark = (channel, label) => {
    diagnostics_channel.subscribe(channel, (msg) => {
      const id = headerValue(msg?.request?.headers, PROBE_ID_HEADER);
      const probe = id ? inFlight.get(id) : null;
      if (probe) probe.marks.push(`${label}@${Date.now() - probe.t0}ms`);
    });
  };
  mark("undici:request:create", "created");
  mark("undici:request:headers", "headers");
  mark("undici:request:error", "error");
  // A new socket carries no request reference, so it is matched by host.
  diagnostics_channel.subscribe("undici:client:connected", (msg) => {
    const host = msg?.connectParams?.hostname || msg?.connectParams?.host;
    if (!host) return;
    const now = Date.now();
    for (const probe of inFlight.values()) {
      if (probe.host === host) probe.marks.push(`connected@${now - probe.t0}ms`);
    }
  });
}


/**
 * Bump whenever a probe's *verdict* changes meaning — a different timeout, a new
 * token field, a new success rule. Stored probe results are then invalidated on
 * boot rather than shown as current: an error string the code can no longer
 * produce ("timeout after 20000ms") is worse than no result at all, because it
 * reads as a live failure.
 *
 * v2: accept any reasoning field, 45s budget, name the failing stage.
 * v3: stages split into connect / headers / first-token — "connect" now means no
 *     socket ever opened, so a provider that accepted the request and never
 *     answered no longer reads as a network failure.
 */
export const PROBE_VERSION = 3;

const DEFAULT_TIMEOUT_MS = 5000;
// Probes get a generous budget: free-tier and reasoning models routinely take
// 5-15s to their first token, and a probe that times out at 20s reports a healthy
// model as broken (observed live: 70s to an *answer* token, 4s to the first one).
const MODEL_PROBE_TIMEOUT_MS = 45_000;
// Reasoning models spend their budget on chain-of-thought before emitting an
// answer, so a tiny max_tokens starves them into an empty response (9Router issue
// #3010). We abort at the first token of ANY kind, so a large budget costs nothing.
const PROBE_MAX_TOKENS = 1024;

/** Every field a provider has been seen to put the first token in. */
const TOKEN_FIELDS = ["content", "reasoning_content", "reasoning", "thinking", "thinking_content", "text"];
const firstTokenIn = (delta) => {
  if (!delta || typeof delta !== "object") return null;
  for (const f of TOKEN_FIELDS) {
    const v = delta[f];
    if (typeof v === "string" && v.length > 0) return f;
  }
  // some providers nest it (e.g. { content: [{ type: "text", text }] })
  if (Array.isArray(delta.content) && delta.content.some((c) => c?.text)) return "content[]";
  return null;
};

const trimBase = (baseUrl) => String(baseUrl || "").replace(/\/+$/, "");

function shapeError(err) {
  return String(err?.cause?.message || err?.message || err).slice(0, 200);
}

/**
 * Probe a node's model list. Returns { ok, latencyMs, modelCount, models } on
 * success, { ok:false, latencyMs, error } otherwise. An endpoint that answers
 * without a JSON body still counts as reachable (modelCount 0).
 */
export async function probeNode(baseUrl, apiKey = null, { timeoutMs = DEFAULT_TIMEOUT_MS, proxy = null } = {}) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A probe from the caller's own address answers a different question than the
    // request path does when a proxy is bound: the provider sees the proxy's IP, so a
    // direct probe can pass while real traffic is blocked (or the reverse).
    //
    // One exit, deliberately: a probe reports what ONE address does, and a failover would
    // hide which one answered. The caller resolves includeCooling so that an exit sitting in
    // a traffic cooldown can still be probed — that is exactly when a user wants to know.
    const agent = getProxyAgent(primaryProxyUrl(proxy));
    const res = agent
      ? await undiciFetch(`${trimBase(baseUrl)}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: controller.signal,
          dispatcher: agent,
        })
      : await fetch(`${trimBase(baseUrl)}/models`, {
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
 * We stop at the first token of ANY kind — content or reasoning — so a reasoning
 * model counts as alive at its first thinking token rather than at its answer.
 *
 * Uses the node's pooled dispatcher so the probe travels the same connection path
 * the proxy uses, but bypasses breakers and usage entirely.
 *
 * Every attempt logs `PROBE` lines at info: a probe the user triggered must never
 * fail silently. `log` is optional so the module stays usable from tests.
 */
export async function probeModel(node, model, connection = null, { timeoutMs, log = null, proxy = null } = {}) {
  const budget = timeoutMs ?? node?.data?.probeTimeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
  const t0 = Date.now();
  const controller = new AbortController();
  let stage = "connect";
  const timer = setTimeout(() => controller.abort(), budget);
  const apiKey = connection?.credentials?.apiKey ?? null;
  const url = node?.apiType === "responses"
    ? `${trimBase(node.baseUrl)}/responses`
    : `${trimBase(node.baseUrl)}/chat/completions`;
  const payload = JSON.stringify({
    model,
    stream: true,
    max_tokens: PROBE_MAX_TOKENS,
    messages: [{ role: "user", content: "ping" }],
  });

  // Track this probe's socket events so a failure can say where it died.
  observeUpstream();
  const probeId = randomUUID().slice(0, 8);
  const probe = { t0, host: new URL(originOf(node?.baseUrl) ?? "http://invalid").hostname, marks: [] };
  inFlight.set(probeId, probe);

  log?.info?.("PROBE", `→ ${node?.prefix ?? "?"}/${model}`, {
    url, budgetMs: budget, key: connection?.name ?? null,
  });

  const fail = (error) => {
    const timeline = probe.marks.join(", ") || "no socket activity";
    log?.warn?.("PROBE", `✖ ${node?.prefix ?? "?"}/${model}`, { stage, error, elapsedMs: Date.now() - t0, timeline });
    return { ok: false, ttftMs: null, latencyMs: Date.now() - t0, error, stage, timeline };
  };

  try {
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
        [PROBE_ID_HEADER]: probeId,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: payload,
      signal: controller.signal,
      dispatcher: getProxyAgent(primaryProxyUrl(proxy)) || getDispatcher(node),
    });

    if (!res.ok) {
      stage = "response";
      const raw = await res.text().catch(() => "");
      // Pull the human sentence out of a JSON error body instead of dumping the blob.
      let detail = "";
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.error?.message || parsed?.msg || parsed?.message
          || (typeof parsed?.error === "string" ? parsed.error : "") || raw;
      } catch { detail = raw; }
      return fail(`HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`);
    }

    stage = "first-token";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawFrame = false;
    let finishReason = null;
    let providerError = null;
    let tokenField = null;

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
          if (!data || data === "[DONE]") continue;
          sawFrame = true;
          try {
            const obj = JSON.parse(data);
            // some providers return 200 with an error envelope in the body
            if (obj?.error) { providerError = obj.error?.message || JSON.stringify(obj.error); break; }
            if (obj?.status && String(obj.status) !== "200" && String(obj.status) !== "0" && (obj.msg || obj.message)) {
              providerError = `${obj.status}: ${obj.msg || obj.message}`;
              break;
            }
            const choice = obj?.choices?.[0];
            const field = firstTokenIn(choice?.delta) ?? firstTokenIn(choice?.message);
            if (field) { tokenField = field; break; }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          } catch { /* non-JSON frame — keep scanning */ }
        }
        if (tokenField || providerError) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* already gone */ }
    }

    if (providerError) return fail(`provider error: ${String(providerError).slice(0, 240)}`);

    const ttftMs = Date.now() - t0;
    if (tokenField) {
      log?.info?.("PROBE", `← ok ${node?.prefix ?? "?"}/${model}`, { ttftMs, via: tokenField });
      return { ok: true, ttftMs, latencyMs: ttftMs, error: null, via: tokenField };
    }
    if (sawFrame) {
      // the stream spoke but produced no token (e.g. an immediate stop) — alive
      log?.info?.("PROBE", `← ok ${node?.prefix ?? "?"}/${model}`, { ttftMs, via: `finish:${finishReason ?? "unknown"}` });
      return { ok: true, ttftMs, latencyMs: ttftMs, error: null, via: `finish:${finishReason ?? "unknown"}` };
    }
    return fail(`stream ended with no token after ${ttftMs}ms`);
  } catch (err) {
    if (controller.signal.aborted) {
      // Headers arrived and the stream went quiet — a different problem again.
      if (stage === "first-token") return fail(`no token within ${budget}ms (stage: first-token)`);
      // A socket that connected and then went quiet is not a connect failure —
      // it is a provider that never answered. Say which, and show the timeline.
      const connected = probe.marks.some((m) => m.startsWith("connected@"));
      stage = connected ? "headers" : "connect";
      return fail(connected
        ? `no response headers within ${budget}ms (stage: headers)`
        : `no socket connected within ${budget}ms (stage: connect)`);
    }
    return fail(`${stage}: ${shapeError(err)}`);
  } finally {
    clearTimeout(timer);
    inFlight.delete(probeId);
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
