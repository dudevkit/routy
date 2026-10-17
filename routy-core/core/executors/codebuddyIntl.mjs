// routy CodeBuddy Intl executor — ported from
// 9router/open-sse/executors/codebuddy-intl.js + the registry entry at
// open-sse/providers/registry/codebuddy-intl.js.
//
// CodeBuddy is an OpenAI-compatible-but-stream-only gateway: it rejects a plain OpenAI
// body (11101 invalid request) and needs a leading system prompt plus user content as
// typed text blocks. It also forces streaming, and surfaces reasoning only when the
// request carries OpenAI-style reasoning params. All of that is mirrored here.
//
// Selected per node via the server-owned marker `data.authProvider === "codebuddy-intl-oauth"`
// — never from a client-supplied executor string (see the chat handler's executor pick).
// The chat endpoint is the fixed registry URL from CODEBUDDY_INTL, so a stored node can
// never redirect OAuth bearer credentials to another host.
//
// Error bodies are sanitized: the provider may echo token-shaped text, and the shared
// executor's default would put the first 500 characters into logs and error details.
import { randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.mjs";
import { CODEBUDDY_INTL } from "../oauth/codebuddyIntl.mjs";

const OAUTH_MARKER = "codebuddy-intl-oauth";

/** True when a node carries the server-owned CodeBuddy Intl OAuth marker. */
export function isCodeBuddyIntlOAuth(node) {
  return node?.data?.authProvider === OAUTH_MARKER;
}

export function codebuddyIntlMarker() {
  return OAUTH_MARKER;
}

/**
 * The request-body pass, shared by the executor and the model probe — two builders
 * would drift into a probe that reports on a request chat never sends.
 *
 * CodeBuddy wants a LEADING system message and user content as typed text blocks, or it
 * answers 11101. What it must NOT do is discard the caller's own system prompt: that
 * prompt is the agent's persona and instructions ("You are Alice…"), and replacing it
 * makes the model answer as CodeBuddy Code regardless of who the client asked for
 * (observed live: a persona prompt came back "Aku CodeBuddy Code, asisten AI…").
 *
 * So the CodeBuddy line is only ADDED when the caller sent no system message at all;
 * an existing system prompt is kept verbatim and stays first.
 *
 * Ported from the reference transformRequest, with that one correction:
 *   · force `stream: true` (CodeBuddy refuses non-streaming);
 *   · `reasoning_effort` "none"/"off" is dropped, any other effort sets reasoning_summary
 *     to "auto" (the field the gateway reads to surface reasoning);
 *   · a plain-string user content becomes a single typed text block.
 */
export function transformCodebuddyBody(model, body) {
  const b = body && typeof body === "object" ? { ...body } : body;
  if (!b || typeof b !== "object") return b;
  if (model && !b.model) b.model = model;
  b.stream = true;

  const eff = b.reasoning_effort;
  if (eff === "none" || eff === "off") delete b.reasoning_effort;
  else if (eff) b.reasoning_summary = "auto";

  const source = Array.isArray(b.messages) ? b.messages : [];
  // Keep the caller's system/developer text (developer folds into a system message, since
  // CodeBuddy takes one leading system turn). The CodeBuddy identity line is a fallback,
  // not a replacement.
  const clientSystem = source
    .filter((m) => m && typeof m === "object" && (m.role === "system" || m.role === "developer"))
    .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content)
      ? m.content.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : "")).join("")
      : ""))
    .filter((t) => t && t.trim().length > 0);
  const systemText = clientSystem.length > 0 ? clientSystem.join("\n\n") : "You are CodeBuddy Code.";

  const rest = [];
  for (const message of source) {
    if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
    if (message.role === "user" && typeof message.content === "string") {
      rest.push({ ...message, content: [{ type: "text", text: message.content }] });
    } else {
      rest.push({ ...message });
    }
  }
  b.messages = [{ role: "system", content: systemText }, ...rest];
  return b;
}

/**
 * The five conversation headers WorkBuddy's gateway requires on every chat call.
 *
 * Observed live 2026-10-17 against `POST /v2/chat/completions` with a fresh OAuth
 * account: without them the gateway answers HTTP 400 `{code: 11128, msg: "request
 * illegal"}` — its channel-verification refusal for a call it does not recognise as
 * coming from the official client. Each of the five alone, and each pair tested, still
 * 400s; all five together flip the identical request to `200` + an SSE stream, after
 * which only the body rules apply (the first message must be a system prompt, which
 * transformCodebuddyBody already guarantees). Identity headers, cookies, HTTP/2 and
 * every product/stainless header combination reproduced none of that flip, so this set
 * is the gate.
 *
 * Values are fresh UUIDs per request — correlation ids the gateway never reads back.
 */
export function codebuddyConversationHeaders() {
  return {
    "X-Conversation-ID": randomUUID(),
    "X-Parent-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
    "X-Session-ID": randomUUID(),
  };
}

/**
 * The fixed registry headers (registry transport.headers) for a CodeBuddy chat call,
 * plus the verified account identity and the conversation set above. `uid` is the
 * WorkBuddy account identity captured at login; without it no identity header is sent.
 */
export function codebuddyChatHeaders(uid = null) {
  return {
    "User-Agent": CODEBUDDY_INTL.chatUserAgent,
    "X-Product": "SaaS",
    "X-IDE-Type": "IDE",
    "X-IDE-Name": "IDE",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    ...(uid ? { "X-User-Id": uid, "X-Domain": CODEBUDDY_INTL.host } : {}),
    ...codebuddyConversationHeaders(),
  };
}

export class CodeBuddyIntlExecutor extends DefaultExecutor {
  /** The fixed registry chat endpoint — never derived from node.baseUrl. */
  buildUrl() {
    return CODEBUDDY_INTL.chatUrl;
  }

  /**
   * CodeBuddy chat error bodies are never surfaced verbatim — only the status. A
   * bounded, allowlisted message keeps tokens and raw provider text out of logs,
   * API errors, and request-detail captures.
   *
   * This redaction is deliberate and stays: the provider's error text may echo tokens.
   * key-health knows an OAuth 429 arrives unclassifiable and treats it as provider-wide
   * instead of cooling the user's only account, so no body signal is needed here.
   */
  errorMessage(status) {
    if (status === 401 || status === 403) return "codebuddy auth rejected (401/403)";
    if (status === 429) return "codebuddy rate limited (429)";
    return `codebuddy upstream error (HTTP ${status})`;
  }

  /**
   * The default executor only knows `credentials.apiKey`; an OAuth row carries
   * `accessToken`. Merge the fixed registry headers with the bearer token, and still
   * honour a media-style `auth` if one is ever passed.
   */
  buildHeaders(auth = null, contentType = null, extra = null) {
    const uid = this.connection?.credentials?.providerSpecificData?.quotaIdentity?.uid ?? null;
    const base = { ...codebuddyChatHeaders(uid), ...super.buildHeaders(auth, contentType, extra) };
    if (!auth) {
      const token = this.connection?.credentials?.accessToken;
      if (token) base.authorization = `Bearer ${token}`;
    }
    return base;
  }

  execute({ model, body, stream, ...rest }) {
    const b = transformCodebuddyBody(model, body);
    return super.execute({
      ...rest,
      model,
      body: b,
      stream: true,                       // forced upstream; the caller's flag is unchanged
      url: CODEBUDDY_INTL.chatUrl,        // fixed endpoint, never node.baseUrl
    });
  }
}

export default CodeBuddyIntlExecutor;
