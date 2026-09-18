// P1.6b — detectFormat port parity (verbatim from upstream services/provider.js).
import { describe, it, expect } from "vitest";
import { detectFormat } from "../core/translate/deps/detectFormat.js";

describe("detectFormat (upstream parity)", () => {
  it("openai-responses: input field, no messages", () => {
    expect(detectFormat({ input: [{ role: "user" }] })).toBe("openai-responses");
    expect(detectFormat({ input: "plain string" })).toBe("openai-responses");
  });

  it("claude: content array + system, no slash in model", () => {
    expect(detectFormat({
      model: "claude-sonnet-4",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })).toBe("claude");
  });

  it("system indicator wins over the slash heuristic (upstream parity)", () => {
    // l2-claude-basic case: slash model + system → claude (translated to openai node)
    expect(detectFormat({
      model: "provider/model",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })).toBe("claude");
    // l2-claude-tooluse case: slash model + NO system + tool_use array → default openai
    expect(detectFormat({
      model: "provider/model",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "f", input: {} }] }],
    })).toBe("openai");
  });

  it("string content defaults to openai; tools and images disambiguate", () => {
    expect(detectFormat({ messages: [{ role: "user", content: "hi" }] })).toBe("openai");
    expect(detectFormat({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t" }] }],
    })).toBe("claude");
    expect(detectFormat({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "x" } }] }],
    })).toBe("openai");
  });
});
