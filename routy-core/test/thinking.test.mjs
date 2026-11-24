// The thinking policy — a provider's reasoning level, decided on the node instead of the client.
// What matters here: `auto` never touches a caller's body, `off` removes every name a reasoning
// setting arrives under, and a forced level replaces the caller's whole shape (leaving one
// behind lets a target format prefer the value the policy just overruled).
import { describe, it, expect } from "vitest";
import { applyThinking, isThinkingMode, validateThinking, THINKING_MODES } from "../core/thinking.mjs";

describe("thinking policy", () => {
  it("leaves the caller's body alone under auto, an absent policy, or an unknown mode", () => {
    const body = { messages: [], reasoning_effort: "high" };
    expect(applyThinking(body, "auto")).toBe(body);
    expect(applyThinking(body, undefined)).toBe(body);
    expect(applyThinking(body, null)).toBe(body);
    // A value that never passed validation must not silently rewrite a request.
    expect(applyThinking(body, "ultra")).toBe(body);
    expect(isThinkingMode("ultra")).toBe(false);
  });

  it("removes reasoning from every shape a caller can send it in", () => {
    const off = applyThinking({ messages: [], reasoning_effort: "high", reasoning: { effort: "low" }, thinking: { type: "enabled" } }, "off");
    expect(off.reasoning_effort).toBeUndefined();
    expect(off.reasoning).toBeUndefined();
    expect(off.thinking).toBeUndefined();
    // Nothing to remove: the same object back, so the caller can log "nothing changed".
    const clean = { messages: [] };
    expect(applyThinking(clean, "off")).toBe(clean);
  });

  it("replaces the caller's shape with the forced level", () => {
    const forced = applyThinking({ messages: [], reasoning_effort: "high", reasoning: { effort: "high", summary: "auto" } }, "medium");
    expect(forced.reasoning_effort).toBe("medium");
    expect(forced.reasoning).toBeUndefined(); // the translator reads this one first
    expect(forced.messages).toEqual([]);

    // Already exactly that: no copy, nothing to report.
    const same = { reasoning_effort: "medium" };
    expect(applyThinking(same, "medium")).toBe(same);
    // Same level but something else is aboard: the extras still go.
    const extra = { reasoning_effort: "medium", thinking: { type: "enabled" } };
    expect(applyThinking(extra, "medium").thinking).toBeUndefined();
  });

  it("validates a stored mode, and null clears it", () => {
    expect(validateThinking(null)).toEqual({ ok: true, value: null });
    expect(validateThinking(undefined)).toEqual({ ok: true, value: null });
    for (const mode of THINKING_MODES) expect(validateThinking(mode)).toEqual({ ok: true, value: mode });
    expect(validateThinking("ultra").ok).toBe(false);
    expect(validateThinking("").ok).toBe(false);
    expect(validateThinking(3).ok).toBe(false);
  });
});
