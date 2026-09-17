// deps shim — verbatim extract from upstream services/provider.js
export function isLastMessageFromUser(body) {
  const messages = body.messages || body.contents;
  if (!messages?.length) return true;
  const lastMsg = messages[messages.length - 1];
  return lastMsg?.role === "user";
}

export function normalizeThinkingConfig(body) {
  if (!isLastMessageFromUser(body)) {
    delete body.thinking;
  }
  return body;
}
