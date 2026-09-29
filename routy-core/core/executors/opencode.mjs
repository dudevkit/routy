// routy opencode executor — a port of9Router's OpenCodeExecutor at decolua/9router v0.5.91,
// the release that RESOLVED the free-tier 403 (our original snapshot, v0.5.75, predates it and
// its bare-UA/uuid-session code is exactly what opencode now refuses). Selected per node via
// `node.data.executor === "opencode"`.
//
// Every piece answers a documented refusal (upstream CHANGELOG v0.5.91 +
// tests/unit/opencode-session.test.js):
//   - User-Agent must be a versioned opencode >= 1.17 (`opencode/1.18.31`); bare "opencode"
//     is answered 403 FreeTierError. A downstream already carrying a valid version passes on.
//   - Session/request ids must match the canonical shapes `ses_`/`msg_` + 12 hex + 14 base62
//     (OPENCODE_SESSION_RE / OPENCODE_REQUEST_RE). Free-tier quota is accounted PER SESSION —
//     minting a fresh one per request surfaces as 429 FreeUsageLimitError — so the session is
//     stable per node (upstream: per downstream identity, LRU + TTL; one node = one identity
//     here). A client's own header is honoured only when it is canonical; a non-canonical one
//     is translated into one, upstream's `translateSessionId` behaviour.
//   - Zen rejects non-streaming free requests (403 FreeTierError): the request streams ALWAYS
//     and chat.mjs's forced-SSE->JSON path answers a non-streaming client.
//   - URL per model: /zen/v1/chat/completions, /zen/v1/responses (muse-spark free models),
//     /zen/v1/messages (union-alpha). Responses bodies: Chat-field renames, store:false,
//     empty-input placeholder, tools normalized, and PRIOR TURN REASONING ITEMS STRIPPED —
//     pooled `Bearer public` accounts cannot decrypt another account's encrypted_content.
//
// NOT ported, deliberately:
//   - injectReasoningContent: the registry defines no reasoningInject for opencode.
//   - the thinking-level clamp: upstream's getThinkingLevels table; effort passes through.
// The free-tier fingerprint IS ported: upstream's utils/opencodeFingerprint.js lives next door
// as ./opencodeFingerprint.mjs (verbatim) — its quartet cloaking is named in the v0.5.91 403 fix.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.mjs";
import { applyFingerprintTools } from "./opencodeFingerprint.mjs";
import {
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
  normalizeResponsesInput,
} from "../translate/formats/responsesApi.js";

const OPENCODE_UA = "opencode/1.18.31";
const ANTHROPIC_API_VERSION = "2023-06-01";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Exact upstream list — plus the same model family by name (helpers.js isMuseSparkModel). */
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 17);
}

function unstableRandom() {
  const bytes = randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += BASE62_CHARS[bytes[i] % 62];
  return out;
}

// Canonical id shapes: 12 hex chars encoding the time, 14 base62 random. Upstream's
// generateSessionId/generateRequestId, verbatim logic.
let lastTimestamp = 0;
let counter = 0;

function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

/** Upstream translateSessionId: keep what is canonical, hash anything else into shape. */
function translateSessionId(sessionId) {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) return sessionId.trim();
  const digest = createHash("sha256").update(`opencode\0generic\0${sessionId || ""}`).digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) randomPart += BASE62_CHARS[digest[i] % 62];
  return `ses_${timeHex}${randomPart}`;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

/** One stable canonical session per node, capped like upstream's store. */
const stableSessions = new Map();
function stableSessionId(nodeId) {
  const key = String(nodeId ?? "default");
  const existing = stableSessions.get(key);
  if (existing) return existing;
  const sessionId = generateSessionId();
  if (stableSessions.size >= 1000) stableSessions.delete(stableSessions.keys().next().value);
  stableSessions.set(key, sessionId);
  return sessionId;
}

function clientHeader(clientHeaders, name) {
  for (const [k, v] of Object.entries(clientHeaders ?? {})) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function lastUserText(body) {
  try {
    const arr = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : null;
    if (!arr) return typeof body?.input === "string" ? body.input.slice(-600) : "";
    for (let i = arr.length - 1; i >= 0; i--) {
      const msg = arr[i];
      if (!msg || (msg.role && msg.role !== "user")) continue;
      const content = msg.content;
      if (typeof content === "string" && content.trim()) return content.trim().slice(-600);
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (typeof part === "string" ? part : part?.text || part?.input_text || ""))
          .join(" ")
          .trim();
        if (text) return text.slice(-600);
      }
    }
  } catch { /* no usable text — caller falls back */ }
  return "";
}

/** Upstream deriveRequestId: the CLI's per-turn message id — stable across retries. */
function deriveRequestId(sessionId, body) {
  const text = lastUserText(body);
  if (!text) return generateRequestId();
  const digest = createHash("sha256").update(`opencode-req\0${sessionId || ""}\0${text}`).digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) randomPart += BASE62_CHARS[digest[i] % 62];
  const id = `msg_${timeHex}${randomPart}`;
  return OPENCODE_REQUEST_RE.test(id) ? id : generateRequestId();
}

function resolveSession(clientHeaders, node, body) {
  const raw = clientHeader(clientHeaders, "x-opencode-session");
  const incoming = normalizeSession(raw);
  if (!incoming) return stableSessionId(node.id);
  return translateSessionId(incoming); // canonical passes through, anything else is hashed into shape
}

function resolveRequestId(clientHeaders, session, body) {
  const raw = normalizeSession(clientHeader(clientHeaders, "x-opencode-request"));
  if (raw && OPENCODE_REQUEST_RE.test(raw)) return raw;
  return deriveRequestId(session, body);
}

/** Strip a `model(level)` thinking suffix and any `prefix/` — upstream baseModelId. */
const baseModelId = (model) => {
  const clean = String(model ?? "").replace(/\([^()]+\)\s*$/, "").trim();
  return clean.includes("/") ? clean.split("/").pop() : clean;
};

const isMuseSparkModel = (model) => /^muse[-_]?spark(?:$|[-_:.\s])/i.test(baseModelId(model));
const isResponsesModel = (model) => RESPONSES_MODELS.has(baseModelId(model)) || isMuseSparkModel(model);
const isMessagesModel = (model) => MESSAGES_MODELS.has(baseModelId(model));

/** Responses tools shape: flat {name, description, parameters} entries, names <= 128. */
function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

/** Strip prior-turn reasoning items: pooled `Bearer public` accounts cannot decrypt another
 *  account's encrypted_content — sending it back is a 400 (upstream's comment, abridged). */
function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

/** Chat -> Responses boundary: name the output cap the Responses way, carry reasoning as
 *  `reasoning:{effort,summary}` (upstream normalizeOpencodeReasoning minus its thinking-level
 *  clamp, which has no table for the models this node serves). */
function applyResponsesShape(body) {
  if (body.max_output_tokens === undefined) {
    if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
    else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
  }
  delete body.max_tokens;
  delete body.max_completion_tokens;

  const currentReasoning = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning : null;
  const requested = typeof body.reasoning_effort === "string" ? body.reasoning_effort : currentReasoning?.effort;
  if (typeof requested === "string") {
    body.reasoning = { ...currentReasoning, effort: requested.toLowerCase().trim() };
    if (!body.reasoning.summary) body.reasoning.summary = "auto";
    delete body.reasoning_effort;
  }
  return body;
}

/** The zen endpoint for one model — shared with core/probe.mjs so a Test hits exactly
 *  what chat hits; two builders would drift into a probe that reports on a request the
 *  chat path never sends. */
export function opencodeUrl(baseUrl, model) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (isResponsesModel(model)) return `${base}/zen/v1/responses`;
  if (isMessagesModel(model)) return `${base}/zen/v1/messages`;
  return `${base}/zen/v1/chat/completions`;
}

/** Canonical endpoint + headers for one request. The model probe uses this too — session,
 *  request id and UA all follow the v0.5.91 rules regardless of who is asking. */
export function opencodeTarget({ node, model, body = null, clientHeaders = null, stream = true }) {
  const url = opencodeUrl(node.baseUrl, model);
  const session = resolveSession(clientHeaders, node, body);
  const request = resolveRequestId(clientHeaders, session, body);
  const downstreamUa = String(clientHeader(clientHeaders, "user-agent") || "");
  const headers = {
    "content-type": "application/json",
    // The free gateway's whole auth — no key exists.
    authorization: "Bearer public",
    // Versioned or passthrough: bare "opencode" is a 403 (their own unit test says so).
    "user-agent": hasValidOpencodeVersion(downstreamUa) ? downstreamUa : OPENCODE_UA,
    "x-opencode-client": clientHeader(clientHeaders, "x-opencode-client") || "desktop",
    "x-opencode-session": session,
    "x-opencode-request": request,
    "x-opencode-project": clientHeader(clientHeaders, "x-opencode-project") || "global",
    accept: stream ? "text/event-stream" : "*/*",
  };
  if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
  return { url, headers, session, request };
}

/** The request-body pass (upstream transformRequest), shared by the executor and the model
 *  probe — two builders would drift into a probe that reports on a request chat never sends. */
export function transformOpencodeBody(model, body) {
  const b = body && typeof body === "object" ? { ...body } : body;
  if (model && b && typeof b === "object" && !b.model) b.model = model;
  const responses = isResponsesModel(model);
  // Zen rejects non-streaming free requests with 403 FreeTierError — always stream upstream;
  // chat.mjs's forced-SSE->JSON path answers a non-streaming client.
  if (b && typeof b === "object") b.stream = true;
  if (responses && b && typeof b === "object") {
    const normalized = normalizeResponsesInput(b.input);
    if (normalized) b.input = normalized;
    if (!Array.isArray(b.input) || b.input.length === 0) {
      b.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    // Chat-only fields are NOT part of the Responses dialect. The chat path arrives already
    // translated (its translator drops them); the probe arrives raw — carrying `messages`
    // into zen/v1/responses is a 400 "unknown parameter".
    delete b.messages;
    applyResponsesShape(b);
    b.store = false;
    normalizeResponsesTools(b);
    sanitizeResponsesItems(b);
    // Fingerprint quartet required even when the client ships its own tools — skipping it
    // is a documented 403 (upstream transformRequest makes the same call).
    applyFingerprintTools(b, true);
  } else if (b && typeof b === "object") {
    applyFingerprintTools(b, false);
  }
  return b;
}

/** Does this model speak the Responses dialect? The chat handler picks its TARGET FORMAT per
 *  model with this — opencode's dialect split is not an apiType, it is the model. */
export const opencodeSpeaksResponses = (model) => isResponsesModel(model);

export class OpenCodeExecutor extends DefaultExecutor {
  execute({ model, body, stream, clientHeaders = null, ...rest }) {
    const b = transformOpencodeBody(model, body);
    const target = opencodeTarget({ node: this.node, model, body: b, clientHeaders, stream: true });
    return super.execute({ ...rest, model, body: b, stream: true, url: target.url, headers: target.headers });
  }
}
