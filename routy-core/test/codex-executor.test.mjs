import { describe, it, expect, vi } from "vitest";
import { CodexExecutor, CODEX_RESPONSES_URL, isCodexOAuth, transformCodexBody } from "../core/executors/codex.mjs";
import { DefaultExecutor } from "../core/executors/default.mjs";
import { translateRequest } from "../core/translate/index.js";
import { createResponseTranslator } from "../core/sse/translateStream.mjs";
import { parseSSEToOpenAIResponse } from "../core/sse/sseToJson.mjs";
import { FORMATS } from "../core/translate/formats.js";

const node = { data: { authProvider: "codex-oauth" } };
const connection = { credentials: { accessToken: "secret", providerSpecificData: { chatgptAccountId: "account" } } };

describe("Codex executor", () => {
  it("selects the OAuth marker and constructs account-scoped headers", () => {
    const executor = new CodexExecutor(node, connection);
    expect(isCodexOAuth(node)).toBe(true);
    expect(isCodexOAuth({ data: { provider: "codex" } })).toBe(true);
    expect(isCodexOAuth({ data: {} })).toBe(false);
    expect(executor.buildUrl()).toBe(CODEX_RESPONSES_URL);
    expect(executor.buildHeaders()).toMatchObject({ authorization: "Bearer secret", "chatgpt-account-id": "account", accept: "text/event-stream" });
    expect(executor.rateLimitIsPerAddress()).toBe(false);
  });

  it("forces the Codex streaming wire and strips unsupported parameters", async () => {
    const execute = vi.spyOn(DefaultExecutor.prototype, "execute").mockResolvedValue({ ok: true });
    try {
      const body = { input: [{ role: "user", content: "hi" }], instructions: "Be precise", max_output_tokens: 20, temperature: 0.5, store: true };
      await new CodexExecutor(node, connection).execute({ model: "gpt-5.3-codex", body, stream: false });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ stream: true, body: { input: body.input, instructions: "Be precise", model: "gpt-5.3-codex", stream: true, store: false } }));
      expect(body.store).toBe(true);
      expect(transformCodexBody("m", { input: [] }).instructions).toBeTruthy();
    } finally { execute.mockRestore(); }
  });

  it("asks for encrypted reasoning only when the request asks for reasoning", () => {
    // store:false keeps nothing server-side, so the reasoning a caller asks for can only come
    // back encrypted and be replayed next turn — the backend refuses the request without it.
    expect(transformCodexBody("m", { input: [] }).include).toBeUndefined();
    expect(transformCodexBody("m", { input: [], reasoning: { effort: "high" } }).include).toEqual(["reasoning.encrypted_content"]);
    // A caller (or the translator) that already asked for it is not doubled.
    expect(transformCodexBody("m", { input: [], reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"] }).include)
      .toEqual(["reasoning.encrypted_content"]);
  });

  it("keeps the upstream error body, sanitized, instead of a bare status", () => {
    // A bare "Codex upstream HTTP 400" is why this failure could not be diagnosed — and why the
    // param-retry saw every Codex 400 as opaque and always spent a retry.
    const message = new CodexExecutor(node, connection).errorMessage(400, "Unsupported parameter: reasoning — see https://x.example/p then Authorization: Bearer sk-abcdefgh1234");
    expect(message).toContain("Codex upstream HTTP 400:");
    expect(message).toContain("Unsupported parameter: reasoning");
    expect(message).not.toContain("sk-abcdefgh1234");
    expect(message).not.toContain("https://x.example/p");
    expect(new CodexExecutor(node, connection).errorMessage(400, "")).toBe("Codex upstream HTTP 400");
  });

  it("converts the caller's reasoning_effort into the shape the backend accepts", () => {
    // Measured on the wire: the ChatGPT backend answers
    // 400 {"detail":"Unsupported parameter: reasoning_effort"} — the translation tree re-emits
    // the OpenAI parameter name for this wire, so the conversion belongs at this boundary.
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6.1-terra", { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }, true);
    expect(translated.reasoning_effort).toBe("high"); // the leak this test pins

    const body = transformCodexBody("gpt-6.1-terra", translated);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    // terra is a "lite" model: a context, never a summary (9Router's registry).
    expect(body.reasoning).toEqual({ effort: "high", context: "all_turns" });

    // Every other codex model takes the summary form instead.
    const plain = transformCodexBody("gpt-5.6-terra", { input: [], reasoning_effort: "high" });
    expect(plain.reasoning).toEqual({ effort: "high", summary: "auto" });
    // The [1m] marker is context, not identity — it must not change which family a model is in.
    expect(transformCodexBody("gpt-6.1-terra[1m]", { input: [], reasoning_effort: "high" }).reasoning)
      .toEqual({ effort: "high", context: "all_turns" });
  });

  it("asks for no reasoning when the caller asks for none", () => {
    const body = transformCodexBody("m", { input: [], reasoning_effort: "none" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.include).toBeUndefined();
  });

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("converts %s tools into Responses input", (format) => {
    const body = format === FORMATS.OPENAI
      ? { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] }
      : { max_tokens: 100, messages: [{ role: "user", content: "hi" }], tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }] };
    const result = translateRequest(format, FORMATS.OPENAI_RESPONSES, "gpt-5.3-codex", body, true);
    expect(result.input.length).toBeGreaterThan(0);
    expect(result.tools[0].name).toBe("lookup");
  });
  it("translates streamed Codex text and tool calls for OpenAI and Anthropic clients", () => {
    const events = [
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_item.added", item: { type: "function_call", id: "item1", call_id: "call1", name: "lookup" } },
      { type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"q":"x"}' },
      { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4 } } },
    ];
    for (const sourceFormat of [FORMATS.OPENAI, FORMATS.CLAUDE]) {
      const translator = createResponseTranslator({ sourceFormat, targetFormat: FORMATS.OPENAI_RESPONSES, model: "gpt-5.3-codex", body: {} });
      const output = events.flatMap((event) => translator.onFrame({ data: JSON.stringify(event) })).concat(translator.flush()).join("");
      expect(output).toContain("Hello");
      expect(output).toContain("lookup");
      if (sourceFormat === FORMATS.OPENAI) {
        const response = parseSSEToOpenAIResponse(output, "gpt-5.3-codex");
        expect(response.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"x"}');
        expect(response.choices[0].finish_reason).toBe("tool_calls");
      } else {
        expect(output).toContain("tool_use");
      }
    }
  });

});
