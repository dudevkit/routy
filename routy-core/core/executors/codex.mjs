import { DefaultExecutor } from "./default.mjs";
import { redactUpstreamText } from "../../lib/mask.mjs";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export function isCodexOAuth(node) {
  return node?.data?.authProvider === "codex-oauth" || node?.data?.provider === "codex";
}

// ChatGPT's Codex backend only accepts streaming Responses requests and does not
// support persistence or the public API's sampling/output-limit parameters.
export function transformCodexBody(model, body) {
  const { max_output_tokens, max_tokens, max_completion_tokens, temperature, top_p, ...rest } = body;
  const upstreamModel = model.replace(/\[1m\]$/, "").replace(/^(gpt-5\.6-(?:sol|terra|luna))-review$/, "$1");
  const out = { ...rest, model: upstreamModel, instructions: body.instructions || "You are a helpful assistant.", stream: true, store: false };
  // With the store off nothing is kept server-side, so the reasoning a caller asks for can
  // only come back encrypted and be replayed on the next turn — which is what Codex itself
  // asks for with this `include`. Measured: a reasoning request without it is refused (400) by
  // the ChatGPT backend for every codex model and every effort value, while the same request
  // without reasoning succeeds. A request that asks for no reasoning is left untouched.
  if (out.reasoning && !(Array.isArray(out.include) && out.include.includes("reasoning.encrypted_content"))) {
    out.include = [...(Array.isArray(out.include) ? out.include : []), "reasoning.encrypted_content"];
  }
  return out;
}

export class CodexExecutor extends DefaultExecutor {
  buildUrl() { return CODEX_RESPONSES_URL; }

  buildHeaders(auth = null, contentType = null, extra = null) {
    const credentials = this.connection?.credentials;
    return {
      ...super.buildHeaders(auth, contentType, extra),
      ...(credentials?.accessToken ? { authorization: `Bearer ${credentials.accessToken}` } : {}),
      ...(credentials?.providerSpecificData?.chatgptAccountId ? { "chatgpt-account-id": credentials.providerSpecificData.chatgptAccountId } : {}),
      accept: "text/event-stream",
      originator: "codex_cli_rs",
    };
  }

  rateLimitIsPerAddress() { return false; }
  /**
   * The upstream body IS the diagnosis. The default executor keeps it; dropping it here is what
   * made every Codex failure read `Codex upstream HTTP 400` with no reason — and what made the
   * param-retry treat every Codex 400 as OPAQUE, so it always spent a retry. Bounded and
   * sanitized (lib/mask.mjs): a provider's prose is the one place a credential arrives as text.
   */
  errorMessage(status, text) {
    const body = redactUpstreamText(text, { max: 300 });
    return `Codex upstream HTTP ${status}${body ? `: ${body}` : ""}`;
  }

  execute({ model, body, ...rest }) {
    return super.execute({ ...rest, model, body: transformCodexBody(model, body), stream: true });
  }
}
