// routy thinking policy — the reasoning level a provider is asked for, set once on the node.
//
// Why a policy and not a passthrough: providers disagree about the vocabulary, and a caller's
// own value can be one the upstream refuses. A ChatGPT/Codex backend is the measured example —
// it answers 400 to a reasoning request whose shape it does not serve, so a client's
// `reasoning_effort` reaches it as an error the operator cannot fix from the client. An
// operator who knows the node fixes it here instead of teaching every client.
//
// Modes:
//   auto  (default) — the caller's own reasoning settings pass through untouched
//   off             — no reasoning is sent at all (the one setting every provider accepts)
//   <level>         — this level is sent on every request, replacing whatever the caller asked
//
// Applied to the SOURCE body, before translation. Every target format derives its own native
// thinking field from these same three names, so one policy covers a Claude, Gemini or
// Responses upstream, and the passthrough path (where the source body IS the outbound body)
// alike. Levels follow the OpenAI enum; a provider that serves fewer answers 400 with the body
// naming the value, which the console shows.
export const THINKING_LEVELS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);
export const THINKING_MODES = Object.freeze(["auto", "off", ...THINKING_LEVELS]);

/** The three names a caller's reasoning can arrive under — the same set the param-retry drops. */
const THINKING_PARAMS = Object.freeze(["reasoning_effort", "reasoning", "thinking"]);

export function isThinkingMode(value) {
  return typeof value === "string" && THINKING_MODES.includes(value);
}

/** Shape check for the management API: `null` clears the policy back to `auto`. */
export function validateThinking(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!isThinkingMode(value)) {
    return { ok: false, detail: `thinking must be one of: ${THINKING_MODES.join(", ")} (or null to clear)` };
  }
  return { ok: true, value };
}

/**
 * Apply `mode` to a caller's body. Returns the SAME object when nothing needs doing, so the
 * caller can compare references to decide whether anything changed; otherwise a copy.
 */
export function applyThinking(body, mode) {
  if (!body || !mode || mode === "auto" || !isThinkingMode(mode)) return body;
  const carried = THINKING_PARAMS.filter((k) => body[k] !== undefined);

  if (mode === "off") {
    if (carried.length === 0) return body;
    const next = { ...body };
    for (const k of THINKING_PARAMS) delete next[k];
    return next;
  }

  // Forced level: the caller's own shape is replaced, not merged — `reasoning_effort` is the
  // name every translator reads, and leaving `reasoning`/`thinking` behind lets a target
  // format prefer the value this policy just overruled.
  if (body.reasoning_effort === mode && carried.length === 1) return body;
  const next = { ...body, reasoning_effort: mode };
  delete next.reasoning;
  delete next.thinking;
  return next;
}
