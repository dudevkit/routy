// P0.4 stub upstream — deterministic openai-compatible SSE endpoint for baseline bench.
import http from "http";

const PORT = parseInt(process.env.STUB_PORT || "20990", 10);
const TOKENS = Array.from({ length: 40 }, (_, i) => ` token${i}`);
let connections = 0;

http.createServer((req, res) => {
  if (req.method === "GET" && req.url.includes("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [
      { id: "stub-large" }, { id: "stub-fast" }, { id: "stub-mini" },
      { id: "stub-vision" }, { id: "stub-reasoning" }, { id: "stub-code" },
    ] }));
    return;
  }
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    connections++;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const id = "chatcmpl-stub-fixture";
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
    res.write(chunk({ role: "assistant" }));
    let i = 0;
    const timer = setInterval(() => {
      if (i < TOKENS.length) {
        res.write(chunk({ content: TOKENS[i++] }));
      } else {
        clearInterval(timer);
        res.write(chunk({}, "stop"));
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [], usage: { prompt_tokens: 50, completion_tokens: TOKENS.length, total_tokens: 50 + TOKENS.length } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 15); // ~40 tokens over ~600ms
    // ServerResponse close = client went away or response finished → stop the timer.
    // (Do NOT use req 'close': on modern Node it fires when the request BODY completes.)
    res.on("close", () => clearInterval(timer));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`stub upstream ready on http://127.0.0.1:${PORT}`));
