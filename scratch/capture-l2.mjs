// P0.1b — L2 golden capture: client-facing bytes through the FULL upstream pipeline
// (Next route → chat.js → chatCore → executor → stub → stream handler → client).
// Requires: bench-stub (:20990) + bench-router (:20991) running and seeded.
// Usage: bun scratch/capture-l2.mjs
// Fixtures land in tests/golden/fixtures-l2/ — reference captures for RE-E's P1
// integration tests. Same normalization rules as L1 (msg_<epoch>, created epoch).
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "tests", "golden", "fixtures-l2");
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:20991";

const CASES = [
  {
    name: "l2-openai-basic-stream",
    body: { model: "bench/test-model", stream: true, max_tokens: 60, messages: [{ role: "user", content: "Say hello." }] },
  },
  {
    name: "l2-openai-basic-nonstream",
    body: { model: "bench/test-model", stream: false, max_tokens: 60, messages: [{ role: "user", content: "Say hello." }] },
  },
  {
    name: "l2-openai-tools-stream",
    body: {
      model: "bench/test-model", stream: true, max_tokens: 60,
      messages: [
        { role: "user", content: "Read main.js" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"main.js\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "console.log('hi')" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    },
  },
  {
    name: "l2-claude-basic-stream",
    body: {
      model: "bench/test-model", stream: true, max_tokens: 60,
      system: "You are a coding assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
    },
    headers: { "anthropic-version": "2023-06-01" },
  },
  {
    name: "l2-claude-tooluse-stream",
    body: {
      model: "bench/test-model", stream: true, max_tokens: 60,
      messages: [
        { role: "user", content: [{ type: "text", text: "Read main.js" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "main.js" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "console.log('hi')" }] },
      ],
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    },
    headers: { "anthropic-version": "2023-06-01" },
  },
];

for (const c of CASES) {
  const t0 = Date.now();
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(c.headers || {}) },
    body: JSON.stringify(c.body),
  });
  const raw = await res.text();
  const meta = { status: res.status, contentType: res.headers.get("content-type") };
  writeFileSync(path.join(OUT, `${c.name}.input.json`), JSON.stringify({ endpoint: "/v1/chat/completions", headers: c.headers || {}, body: c.body }, null, 2) + "\n");
  writeFileSync(path.join(OUT, `${c.name}.expected.client.txt`), raw);
  writeFileSync(path.join(OUT, `${c.name}.meta.json`), JSON.stringify(meta, null, 2) + "\n");
  console.log(`${c.name}: ${res.status} ${raw.length}B in ${meta.ms}ms (${meta.contentType})`);
}
console.log("L2 capture done →", OUT);
