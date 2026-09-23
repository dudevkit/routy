// P0.1/P0.2 — golden fixture capture at translator level (L1).
// Run with bun from axolotl root: bun rigs/capture-golden.mjs
// Captures: (a) request translation openai<->claude, (b) response SSE translation
// upstream->client for openai/claude in both directions + passthrough.
import { mkdirSync, writeFileSync, existsSync } from "fs";
import path from "path";

const ROOT = process.cwd();
const R9 = path.join(ROOT, "9router");
const OUT = path.join(ROOT, "tests", "golden", "fixtures");
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = path.join(ROOT, "rigs", "golden-data");

const { FORMATS } = await import(path.join(R9, "open-sse/translator/formats.js"));
const { translateRequest, initState } = await import(path.join(R9, "open-sse/translator/index.js"));
const { createSSETransformStreamWithLogger } = await import(path.join(R9, "open-sse/utils/stream.js"));

const noopLogger = new Proxy({}, { get: () => () => {} });
const credentials = { _clientSessionId: "golden-session" };

let pass = 0, fail = 0;
const failures = [];

// ---------- request fixtures ----------
const REQUEST_CASES = [
  {
    name: "req-openai-basic",
    source: FORMATS.OPENAI, target: FORMATS.CLAUDE,
    body: {
      model: "test-model", stream: true, max_tokens: 1024, temperature: 0.7,
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "List the files in src/" },
        { role: "assistant", content: "Sure, checking now." },
        { role: "user", content: "Also explain package.json" },
      ],
    },
  },
  {
    name: "req-openai-tools",
    source: FORMATS.OPENAI, target: FORMATS.CLAUDE,
    body: {
      model: "test-model", stream: true, max_tokens: 2048,
      messages: [
        { role: "user", content: "Read file main.js then summarize" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"main.js\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "console.log('hi')" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    },
  },
  {
    name: "req-openai-reasoning",
    source: FORMATS.OPENAI, target: FORMATS.CLAUDE,
    body: {
      model: "test-model", stream: true, max_tokens: 1024,
      messages: [
        { role: "user", content: "Think step by step" },
        { role: "assistant", content: "Result", reasoning_content: "Step 1: analyze. Step 2: answer." },
        { role: "user", content: "Go on" },
      ],
    },
  },
  {
    name: "req-claude-basic",
    source: FORMATS.CLAUDE, target: FORMATS.OPENAI,
    body: {
      model: "test-model", stream: true, max_tokens: 1024,
      system: "You are a coding assistant.",
      messages: [
        { role: "user", content: [{ type: "text", text: "List the files in src/" }] },
        { role: "assistant", content: [{ type: "text", text: "Sure, checking now." }] },
        { role: "user", content: [{ type: "text", text: "Also explain package.json" }] },
      ],
    },
  },
  {
    name: "req-claude-tools",
    source: FORMATS.CLAUDE, target: FORMATS.OPENAI,
    body: {
      model: "test-model", stream: true, max_tokens: 2048,
      messages: [
        { role: "user", content: [{ type: "text", text: "Read file main.js then summarize" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "main.js" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "console.log('hi')" }] },
      ],
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    },
  },
  {
    name: "req-claude-thinking",
    source: FORMATS.CLAUDE, target: FORMATS.OPENAI,
    body: {
      model: "test-model", stream: true, max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 800 },
      messages: [
        { role: "user", content: [{ type: "text", text: "Think step by step" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "Step 1: analyze. Step 2: answer." }, { type: "text", text: "Result" }] },
        { role: "user", content: [{ type: "text", text: "Go on" }] },
      ],
    },
  },
];

for (const c of REQUEST_CASES) {
  const inFile = path.join(OUT, `${c.name}.input.json`);
  writeFileSync(inFile, JSON.stringify({ sourceFormat: c.source, targetFormat: c.target, model: "test-model", body: c.body }, null, 2) + "\n");
  try {
    const translated = translateRequest(c.source, c.target, "test-model", structuredClone(c.body), true, credentials, null, noopLogger, [], null, null);
    if (!translated) throw new Error("translateRequest returned falsy");
    const rawMap = translated._toolNameMap instanceof Map ? Object.fromEntries(translated._toolNameMap) : (translated._toolNameMap || null);
    const meta = { _toolNameMap: rawMap };
    delete translated._toolNameMap;
    delete translated._customToolNames;
    writeFileSync(path.join(OUT, `${c.name}.expected.json`), JSON.stringify({ meta, body: translated }, null, 2) + "\n");
    pass++;
  } catch (e) {
    fail++; failures.push(`${c.name}: ${e.message}`);
  }
}

// ---------- response stream fixtures ----------
const OPENAI_SSE = {
  "sse-openai-basic": [
    `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}`,
    `data: [DONE]`,
  ],
  "sse-openai-toolcall": [
    `data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"main.js\\"}"}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
  ],
  "sse-openai-reasoning": [
    `data: {"id":"chatcmpl-3","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Step 1: "},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-3","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"reasoning_content":"analyze"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-3","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-3","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
  ],
};
const CLAUDE_SSE = {
  "sse-claude-basic": [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"usage":{"input_tokens":12,"output_tokens":1}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ],
  "sse-claude-tooluse": [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"test-model","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file","input":{}}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"main.js\\"}"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ],
  "sse-claude-thinking": [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_3","type":"message","role":"assistant","model":"test-model","content":[],"usage":{"input_tokens":9,"output_tokens":1}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Step 1: analyze"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ],
};

const STREAM_CASES = [
  // upstream openai -> client claude
  ...Object.keys(OPENAI_SSE).map((k) => ({ name: `${k}__to-claude-client`, upstream: FORMATS.OPENAI, client: FORMATS.CLAUDE, lines: OPENAI_SSE[k] })),
  // upstream openai -> client openai (passthrough)
  { name: "sse-openai-basic__to-openai-client", upstream: FORMATS.OPENAI, client: FORMATS.OPENAI, lines: OPENAI_SSE["sse-openai-basic"] },
  // upstream claude -> client openai
  ...Object.keys(CLAUDE_SSE).map((k) => ({ name: `${k}__to-openai-client`, upstream: FORMATS.CLAUDE, client: FORMATS.OPENAI, lines: CLAUDE_SSE[k] })),
];

async function runStream(c) {
  const raw = c.lines.map((l) => l + "\n\n").join("");
  writeFileSync(path.join(OUT, `${c.name}.input.sse.txt`), raw);
  const usageResult = { current: null };
  const onStreamComplete = (info) => { usageResult.current = info; };
  const ts = createSSETransformStreamWithLogger(c.upstream, c.client, null, noopLogger, null, "test-model", null, { messages: [{ role: "user", content: "hi" }] }, onStreamComplete, null, null, credentials);
  const chunks = [];
  const writable = new WritableStream({ write(chunk) { chunks.push(chunk); } });
  const readable = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(raw));
      ctrl.close();
    },
  });
  await readable.pipeThrough(ts).pipeTo(writable);
  const out = chunks.map((ch) => (typeof ch === "string" ? ch : new TextDecoder().decode(ch))).join("");
  writeFileSync(path.join(OUT, `${c.name}.expected.sse.txt`), out);
  if (usageResult.current !== null) {
    writeFileSync(path.join(OUT, `${c.name}.expected.usage.json`), JSON.stringify(usageResult.current, null, 2) + "\n");
  }
}

for (const c of STREAM_CASES) {
  try {
    await runStream(c);
    pass++;
  } catch (e) {
    fail++; failures.push(`${c.name}: ${e.message}`);
  }
}

console.log(`captured: ${pass} ok, ${fail} failed`);
if (failures.length) console.log("FAILURES:\n" + failures.join("\n"));
if (!existsSync(path.join(OUT))) console.log("no fixture dir!");
