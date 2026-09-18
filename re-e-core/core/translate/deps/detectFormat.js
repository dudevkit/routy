// RE-E — verbatim port of upstream services/provider.js detectFormat
// (9router/open-sse/services/provider.js:33-111). Body-structure based request
// format detection, used when the endpoint path doesn't pin the format.

// Detect request format from body structure
export function detectFormat(body) {
  // OpenAI Responses API: has input (array or string) instead of messages[]
  // The Responses API accepts both input as array and input as a plain string
  if (body.input && (Array.isArray(body.input) || typeof body.input === "string") && !body.messages) {
    return "openai-responses";
  }

  // Antigravity format: Gemini wrapped in body.request
  if (body.request?.contents && body.userAgent === "antigravity") {
    return "antigravity";
  }

  // Gemini format: has contents array
  if (body.contents && Array.isArray(body.contents)) {
    return "gemini";
  }

  // OpenAI-specific indicators (check BEFORE Claude)
  // These fields are OpenAI-specific and never appear in Claude format
  if (
    body.stream_options ||           // OpenAI streaming options
    body.response_format ||           // JSON mode, etc.
    body.logprobs !== undefined ||    // Log probabilities
    body.top_logprobs !== undefined ||
    body.n !== undefined ||           // Number of completions
    body.presence_penalty !== undefined ||  // Penalties
    body.frequency_penalty !== undefined ||
    body.logit_bias ||                // Token biasing
    body.user                         // User identifier
  ) {
    return "openai";
  }

  // Claude format: messages with content as array of objects with type
  // Claude requires content to be array with specific structure
  if (body.messages && Array.isArray(body.messages)) {
    const firstMsg = body.messages[0];

    // If content is array, check if it follows Claude structure
    if (firstMsg?.content && Array.isArray(firstMsg.content)) {
      const firstContent = firstMsg.content[0];

      // Claude format has specific types: text, image, tool_use, tool_result
      // OpenAI multimodal has: text, image_url (note the difference)
      if (firstContent?.type === "text" && !body.model?.includes("/")) {
        // Could be Claude or OpenAI multimodal
        // Check for Claude-specific fields
        if (body.system || body.anthropic_version) {
          return "claude";
        }
        // Check if image format is Claude (source.type) vs OpenAI (image_url.url)
        const hasClaudeImage = firstMsg.content.some((c) =>
          c.type === "image" && c.source?.type === "base64"
        );
        const hasOpenAIImage = firstMsg.content.some((c) =>
          c.type === "image_url" && c.image_url?.url
        );
        if (hasClaudeImage) return "claude";
        if (hasOpenAIImage) return "openai";

        // If still unclear, check for tool format
        const hasClaudeTool = firstMsg.content.some((c) =>
          c.type === "tool_use" || c.type === "tool_result"
        );
        if (hasClaudeTool) return "claude";
      }
    }

    // If content is string, it's likely OpenAI (Claude also supports this)
    // Check for other Claude-specific indicators
    if (body.system !== undefined || body.anthropic_version) {
      return "claude";
    }
  }

  // Default to OpenAI format
  return "openai";
}
