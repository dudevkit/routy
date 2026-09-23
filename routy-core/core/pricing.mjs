// routy node pricing — cost per request, from configuration rather than a bundled
// catalogue. A node with no `data.pricing` is UNMETERED: its usage records cost
// null and it can never push the daily budget over its ceiling. That is what makes
// "budget exhausted → keep working on the free/local node" fall out for free.
export function priceOf(node) {
  const p = node?.data?.pricing;
  if (!p || typeof p !== "object") return null;
  const inputPer1M = Number(p.inputPer1M);
  const outputPer1M = Number(p.outputPer1M);
  const hasInput = Number.isFinite(inputPer1M);
  const hasOutput = Number.isFinite(outputPer1M);
  if (!hasInput && !hasOutput) return null;
  return { inputPer1M: hasInput ? inputPer1M : 0, outputPer1M: hasOutput ? outputPer1M : 0 };
}

/**
 * Cost in USD for one completed request, or null when the node is unmetered.
 * Tokens are the upstream-reported (or estimated) counts we already record.
 */
export function costOf(node, { promptTokens = 0, completionTokens = 0 } = {}) {
  const price = priceOf(node);
  if (!price) return null;
  const p = Number.isFinite(promptTokens) ? promptTokens : 0;
  const c = Number.isFinite(completionTokens) ? completionTokens : 0;
  return (p / 1_000_000) * price.inputPer1M + (c / 1_000_000) * price.outputPer1M;
}

export const isMetered = (node) => priceOf(node) !== null;
