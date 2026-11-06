// routy Antigravity executor — a port of 9Router's AntigravityExecutor.
// Talks to Google Cloud Code / Gemini CLI internal API at
// https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse.
//
// Selected per node via server-owned marker `data.authProvider === "antigravity-oauth"`
// or `data.provider === "antigravity"`.

import { DefaultExecutor } from "./default.mjs";
import { ANTIGRAVITY, isAntigravityOAuth } from "../oauth/antigravity.mjs";

export { isAntigravityOAuth };

const IMAGE_MODEL_PATTERNS = [/image/i, /imagen/i, /image-generation/i];

function isImageModel(model) {
  if (!model) return false;
  return IMAGE_MODEL_PATTERNS.some((p) => p.test(model));
}

export const ANTIGRAVITY_PROMPT_REWRITES = [
  { from: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", to: "" },
  { from: /You are Hermes(?: Agent)?(?:,\s*(?:an intelligent AI assistant|an AI assistant|an AI agent))?(?:,?\s*(?:built|created)\s+by\s+Nous Research)?\./gi, to: "You are an AI assistant." },
  { from: /^x-anthropic-billing-header:[^\n]*(?:\r?\n)*/gim, to: "" },
  { from: /opencode/gi, to: (m) => (m === "OpenCode" ? "Antigravity" : m === "OPENCODE" ? "ANTIGRAVITY" : "antigravity") },
];

/** Clean competing-agent brandings that trigger fake 429 RESOURCE_EXHAUSTED from Google. */
export function rewriteAntigravityPromptText(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) {
    out = typeof from === "string" ? out.replaceAll(from, to) : out.replace(from, to);
  }
  return out;
}

export function sanitizeAntigravitySystemInstruction(systemInstruction) {
  if (!systemInstruction?.parts || !Array.isArray(systemInstruction.parts)) return;
  for (const part of systemInstruction.parts) {
    if (typeof part.text === "string") {
      part.text = rewriteAntigravityPromptText(part.text);
    }
  }
}

export class AntigravityExecutor extends DefaultExecutor {
  /** Daily internal endpoint for chat or non-streaming image generation. */
  buildUrl(model = "", stream = true) {
    const isImage = isImageModel(model);
    const action = stream && !isImage ? "streamGenerateContent?alt=sse" : "generateContent";
    let base = ANTIGRAVITY.chatUrl;
    if (this.node?.baseUrl && this.node.baseUrl.startsWith("http")) {
      try {
        const u = new URL(this.node.baseUrl);
        if (!u.hostname.includes("cloudcode-pa.googleapis.com")) {
          base = u.pathname.length > 1 ? this.node.baseUrl.replace(/\/+$/, "") : `${this.node.baseUrl.replace(/\/+$/, "")}/v1internal`;
        }
      } catch {}
    }
    return `${base}:${action}`;
  }

  buildHeaders(auth = null, contentType = null, extra = null) {
    const token = this.connection?.credentials?.accessToken;
    return {
      "content-type": contentType ?? "application/json",
      "User-Agent": ANTIGRAVITY.userAgent,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(extra ?? {}),
    };
  }

  /**
   * Antigravity rate limits are account-scoped (GCP daily quota).
   * A 429 is not the proxy exit's fault.
   */
  rateLimitIsPerAddress() {
    return false;
  }

  errorMessage(status, text) {
    if ((status === 429 || status === 409) && text) {
      try {
        const j = JSON.parse(text);
        const msg = j?.error?.message;
        if (typeof msg === "string" && msg) return `antigravity quota limit: ${msg.slice(0, 200)}`;
      } catch {
        /* fallback below */
      }
    }
    return super.errorMessage(status, text);
  }

  execute({ model, body, stream, ...rest }) {
    // If request has systemInstruction, sanitize prompt rewrites
    if (body?.request?.systemInstruction) {
      sanitizeAntigravitySystemInstruction(body.request.systemInstruction);
    }
    const isImage = isImageModel(model);
    const url = this.buildUrl(model, stream);
    return super.execute({
      ...rest,
      model,
      body,
      stream: stream && !isImage,
      url,
    });
  }
}

export default AntigravityExecutor;
