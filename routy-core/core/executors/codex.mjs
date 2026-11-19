import { DefaultExecutor } from "./default.mjs";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export function isCodexOAuth(node) {
  return node?.data?.authProvider === "codex-oauth" || node?.data?.provider === "codex";
}

// ChatGPT's Codex backend only accepts streaming Responses requests and does not
// support persistence or the public API's sampling/output-limit parameters.
export function transformCodexBody(model, body) {
  const { max_output_tokens, max_tokens, max_completion_tokens, temperature, top_p, ...rest } = body;
  const upstreamModel = model.replace(/\[1m\]$/, "").replace(/^(gpt-5\.6-(?:sol|terra|luna))-review$/, "$1");
  return { ...rest, model: upstreamModel, instructions: body.instructions || "You are a helpful assistant.", stream: true, store: false };
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
  errorMessage(status) { return `Codex upstream HTTP ${status}`; }

  execute({ model, body, ...rest }) {
    return super.execute({ ...rest, model, body: transformCodexBody(model, body), stream: true });
  }
}
