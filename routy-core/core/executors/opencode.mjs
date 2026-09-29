// routy opencode executor — a port of 9Router's `OpenCodeExecutor`
// (9router/open-sse/executors/opencode.js), selected per node via `node.data.executor`.
//
// opencode is the one registry entry whose transport cannot be a URL: its baseUrl is the
// website, and every real request is composed by9Router's bespoke executor. What it does,
// and what this port keeps byte-for-byte:
//   - URL per model: `/zen/v1/chat/completions`, or `/zen/v1/responses` for muse-spark
//     free models (9Router executor lines 66-71) — Responses body shape at that boundary
//     (`max_output_tokens`, `reasoning:{effort,summary}`), the Chat fields deleted.
//   - Headers: `Authorization: Bearer public` (no key exists — this is the free gateway),
//     `x-opencode-client/session/request/project`, User-Agent `opencode` unless the
//     downstream client already is one (its session/id pass through untouched).
//   - Session: stable per node (`ses_<node.id>` — node ids are uuids), so a node keeps one
//     session across requests the way upstream keeps one per connection; a client that
//     sends `x-opencode-session` itself is always honoured.
//
// NOT ported, deliberately: `injectReasoningContent` (its provider rule reads
// `transport.reasoningInject`, which the opencode registry entry does not define — for
// kimi/deepseek *model* rules only) and the thinking-level clamp (9Router's
// `getThinkingLevels("opencode", …)` has no opencode table — the clamp never fired there).
import { randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.mjs";

/** Exact upstream list — plus the same model family by name (helpers.js isMuseSparkModel). */
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

/** Strip a `model(level)` thinking suffix and any `prefix/` — upstream baseModelId. */
const baseModelId = (model) => {
  const clean = String(model ?? "").replace(/\([^()]+\)\s*$/, "").trim();
  return clean.includes("/") ? clean.split("/").pop() : clean;
};

const isMuseSparkModel = (model) => /^muse[-_]?spark(?:$|[-_:.\s])/i.test(baseModelId(model));

const isResponsesModel = (model) => RESPONSES_MODELS.has(baseModelId(model)) || isMuseSparkModel(model);

/**
 * Responses models only: name the output cap the way the Responses API does and carry
 * reasoning as `reasoning:{effort,summary}`. `max/ultra` clamping was upstream's
 * thinking-level table — which has no opencode entries, so effort passes through lowercased
 * exactly as it did there.
 */
function toResponsesBody(body) {
  const out = { ...body };
  if (out.max_output_tokens === undefined) {
    if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens;
    else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens;
  }
  delete out.max_tokens;
  delete out.max_completion_tokens;

  // Upstream normalizeOpencodeReasoning: effort from reasoning_effort or reasoning.effort,
  // string-typed only; summary defaults to auto; the Chat-style flag is deleted either way
  // it arrived.
  const currentReasoning = out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning) ? out.reasoning : null;
  const requested = typeof out.reasoning_effort === "string" ? out.reasoning_effort : currentReasoning?.effort;
  if (typeof requested === "string") {
    out.reasoning = { ...currentReasoning, effort: requested.toLowerCase().trim() };
    if (!out.reasoning.summary) out.reasoning.summary = "auto";
    delete out.reasoning_effort;
  }
  return out;
}

export class OpenCodeExecutor extends DefaultExecutor {
  execute({ model, body, stream, clientHeaders = null, ...rest }) {
    const lower = {};
    for (const [k, v] of Object.entries(clientHeaders ?? {})) lower[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;

    const base = (this.node.baseUrl || "").replace(/\/+$/, "");
    const responses = isResponsesModel(model);
    const url = responses ? `${base}/zen/v1/responses` : `${base}/zen/v1/chat/completions`;

    const downstreamUa = (lower["user-agent"] || "").toLowerCase();
    const headers = {
      "user-agent": downstreamUa.includes("opencode") ? lower["user-agent"] : "opencode",
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": lower["x-opencode-session"] || `ses_${this.node.id}`,
      "x-opencode-request": lower["x-opencode-request"] || `msg_${randomUUID()}`,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      accept: stream ? "text/event-stream" : "*/*",
    };

    return super.execute({
      ...rest,
      model,
      body: responses ? toResponsesBody(body) : body,
      stream,
      url,
      // The free gateway: no key exists, the fixed public bearer IS upstream's auth.
      auth: { style: "bearer", secret: "public" },
      headers,
    });
  }
}
