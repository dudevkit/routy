// End-to-end exercise of /v1/chat/completions against the live gateway.
//   1. normal chat (non-streaming + streaming)
//   2. agentic use (tool definitions → tool_call → tool result → final answer)
//   3. write simple code
const BASE = process.env.REE_BASE ?? "http://127.0.0.1:8010";
const MODEL = process.env.REE_MODEL ?? "bai/deepseek-v4.1-flash";

const t0 = Date.now();
const since = () => `${String(Date.now() - t0).padStart(6)}ms`;

async function call(body, { stream = false } = {}) {
  const t = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, ...body, stream }),
  });
  if (!stream) {
    const json = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t, json, raw: json ? null : "(unparseable)" };
  }
  // read SSE, record time-to-first-frame and reassemble
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", firstFrame = null, frames = 0, usage = null, finish = null, tools = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (!frame.startsWith("data:")) continue;
      const data = frame.slice(5).trim();
      if (data === "[DONE]") continue;
      frames++;
      if (firstFrame === null) firstFrame = Date.now() - t;
      const obj = JSON.parse(data);
      const c = obj.choices?.[0];
      if (c?.delta?.content) text += c.delta.content;
      if (c?.delta?.reasoning_content) text += ""; // thinking, not the answer
      if (c?.delta?.tool_calls) for (const tc of c.delta.tool_calls) {
        const idx = tc.index ?? 0;
        tools[idx] ??= { id: "", name: "", args: "" };
        if (tc.id) tools[idx].id = tc.id;
        if (tc.function?.name) tools[idx].name = tc.function.name;
        if (tc.function?.arguments) tools[idx].args += tc.function.arguments;
      }
      if (c?.finish_reason) finish = c.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  return { status: res.status, ms: Date.now() - t, firstFrame, frames, text, tools, finish, usage };
}

const KEY = process.argv[2] ?? "";
const line = (s) => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);

// ── 1. normal chat ──────────────────────────────────────────────────────────
line("1a. NORMAL CHAT — non-streaming");
{
  const r = await call({ messages: [{ role: "user", content: "In one sentence, what is a reverse proxy?" }] });
  console.log(`status ${r.status} · ${r.ms}ms`);
  if (r.status !== 200) { console.log(JSON.stringify(r.json ?? r.raw)); }
  else {
    console.log(`content: ${r.json.choices[0].message.content}`);
    console.log(`finish: ${r.json.choices[0].finish_reason} · usage: ${JSON.stringify(r.json.usage)}`);
  }
}

line("1b. NORMAL CHAT — streaming");
{
  const r = await call({ messages: [{ role: "user", content: "Count from 1 to 5, comma separated, nothing else." }] }, { stream: true });
  console.log(`status ${r.status} · ${r.ms}ms · ttft ${r.firstFrame}ms · ${r.frames} frames`);
  console.log(`content: ${JSON.stringify(r.text.trim())}`);
  console.log(`finish: ${r.finish} · usage: ${JSON.stringify(r.usage)}`);
}

// ── 2. agentic use ──────────────────────────────────────────────────────────
line("2. AGENTIC USE — tool calling (streaming), full round trip");
const tools = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" }, unit: { type: "string", enum: ["c", "f"] } },
      required: ["city"],
    },
  },
}];
{
  const r = await call({
    messages: [{ role: "user", content: "What's the weather in Tokyo right now? Use the tool." }],
    tools,
    tool_choice: "auto",
  }, { stream: true });
  console.log(`status ${r.status} · ${r.ms}ms · ttft ${r.firstFrame}ms · ${r.frames} frames`);
  console.log(`finish: ${r.finish}`);
  console.log(`tool_calls: ${JSON.stringify(r.tools, null, 1)}`);
  const tc = r.tools[0];
  if (!tc) { console.log("!! no tool call emitted"); }
  else {
    let args = null;
    try { args = JSON.parse(tc.args); } catch { /* not JSON */ }
    console.log(`args parse as JSON: ${args ? "yes " + JSON.stringify(args) : "NO — " + tc.args}`);
    // second leg: feed the tool result back and require a natural answer
    const r2 = await call({
      messages: [
        { role: "user", content: "What's the weather in Tokyo right now? Use the tool." },
        { role: "assistant", content: null, tool_calls: [{ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }] },
        { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ city: "Tokyo", temp_c: 21, conditions: "clear" }) },
      ],
      tools,
    });
    console.log(`\nleg 2 (tool result fed back): status ${r2.status} · ${r2.ms}ms`);
    if (r2.status === 200) {
      console.log(`answer: ${r2.json.choices[0].message.content}`);
      console.log(`finish: ${r2.json.choices[0].finish_reason}`);
    } else console.log(JSON.stringify(r2.json ?? r2.raw));
  }
}

// ── 3. write simple code ────────────────────────────────────────────────────
line("3. WRITE SIMPLE CODE");
{
  const r = await call({
    messages: [{ role: "user", content: "Write a JavaScript function `fizzbuzz(n)` that returns an array of the first n FizzBuzz values. Output only the code in one fenced block, no explanation." }],
  });
  console.log(`status ${r.status} · ${r.ms}ms`);
  if (r.status !== 200) console.log(JSON.stringify(r.json ?? r.raw));
  else {
    const c = r.json.choices[0].message.content;
    console.log(c);
    console.log(`finish: ${r.json.choices[0].finish_reason} · usage: ${JSON.stringify(r.json.usage)}`);
    // actually run it, so "it wrote code" means the code works
    const m = c.match(/```(?:js|javascript)?\n([\s\S]*?)```/);
    if (m) {
      try {
        const fn = new Function(`${m[1]}\nreturn fizzbuzz;`)();
        console.log(`\nexecuted: fizzbuzz(15) = ${JSON.stringify(fn(15))}`);
      } catch (e) { console.log(`\n!! code failed to run: ${e.message}`); }
    } else console.log("\n(no fenced block found to execute)");
  }
}

console.log(`\nall requests done at ${since()}`);
process.exit(0);
