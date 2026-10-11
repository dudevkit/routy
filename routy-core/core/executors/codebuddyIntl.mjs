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
 * Ported verbatim from the reference transformRequest:
 *   · force `stream: true` (CodeBuddy refuses non-streaming);
 *   · `reasoning_effort` "none"/"off" is dropped, any other effort sets reasoning_summary
 *     to "auto" (the field the gateway reads to surface reasoning);
 *   · a leading system prompt replaces the client's, and client system/developer turns
 *     are dropped — a bare OpenAI body is answered 11101;
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
  b.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
  for (const message of source) {
    if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
    if (message.role === "user" && typeof message.content === "string") {
      b.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
    } else {
      b.messages.push({ ...message });
    }
  }
  return b;
}

/** The fixed registry headers (registry transport.headers) for a CodeBuddy chat call. */
export function codebuddyChatHeaders() {
  return {
    "User-Agent": CODEBUDDY_INTL.chatUserAgent,
    "X-Product": "SaaS",
    "X-IDE-Type": "IDE",
    "X-IDE-Name": "IDE",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
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
    const base = { ...codebuddyChatHeaders(), ...super.buildHeaders(auth, contentType, extra) };
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
