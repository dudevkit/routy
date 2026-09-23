// P3 chaos stub upstream — same shape as stub-upstream.mjs but the requested
// model selects the failure mode, so one node baseUrl can exercise every
// stability path: ok | stall | die | big | slow | flaky.
import http from "http";

const PORT = parseInt(process.env.STUB_PORT || "20995", 10);
const DELAY_MS = parseInt(process.env.STUB_DELAY_MS || "0", 10); // per-request first-byte delay
const TOKENS = Array.from({ length: 40 }, (_, i) => ` token${i}`);
const stats = { requests: 0, modes: {} };

function chunkLine(delta, finish) {
  return `data: ${JSON.stringify({ id: "chatcmpl-chaos", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
}

function usageLine(completion) {
  return `data: ${JSON.stringify({ id: "chatcmpl-chaos", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [], usage: { prompt_tokens: 50, completion_tokens: completion, total_tokens: 50 + completion } })}\n\n`;
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url.includes("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "stub-large" }, { id: "stub-fast" }] }));
    return;
  }
  if (req.method === "GET" && req.url.includes("/stats")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const model = String(parsed.model || "ok");
    const mode = ["stall", "die", "big", "slow", "long", "ok"].find((m) => model.includes(m)) || "ok";
    stats.requests++;
    stats.modes[mode] = (stats.modes[mode] || 0) + 1;

    // DELAY_MS holds the response before its FIRST byte, so a "slow" instance is
    // genuinely slow to first token — which is what latency-aware routing ranks on.
    if (DELAY_MS > 0) {
      const hold = setTimeout(send, DELAY_MS);
      res.on("close", () => clearTimeout(hold));
      return;
    }
    send();

    function send() {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunkLine({ role: "assistant" }));

    if (mode === "stall") {
      res.write(chunkLine({ content: "partial" }));
      return; // headers + one chunk, then silence forever (never ends)
    }
    if (mode === "die") {
      res.write(chunkLine({ content: "before-crash" }));
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    if (mode === "big") {
      // ~40k chunks * ~150B ≈ 6MB of SSE, then a clean finish
      let i = 0;
      const n = 40_000;
      const pump = () => {
        while (i < n) {
          if (!res.write(chunkLine({ content: "a".repeat(120) }))) { i++; res.once("drain", pump); return; }
          i++;
        }
        res.write(chunkLine({}, "stop"));
        res.write(usageLine(n));
        res.write("data: [DONE]\n\n");
        res.end();
      };
      pump();
      return;
    }
    if (mode === "slow") {
      let i = 0;
      const timer = setInterval(() => {
        if (i < 6) res.write(chunkLine({ content: TOKENS[i++] }));
        else {
          clearInterval(timer);
          res.write(chunkLine({}, "stop"));
          res.write(usageLine(6));
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 300); // 6 chunks * 300ms = 1.8s, each gap under a 2s watchdog
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (mode === "long") {
      // ~8s stream: used to prove graceful shutdown drains instead of truncating
      let i = 0;
      const timer = setInterval(() => {
        if (i < 40) res.write(chunkLine({ content: ` long${i++}` }));
        else {
          clearInterval(timer);
          res.write(chunkLine({}, "stop"));
          res.write(usageLine(40));
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 200);
      res.on("close", () => clearInterval(timer));
      return;
    }

    // ok
    let i = 0;
    const timer = setInterval(() => {
      if (i < TOKENS.length) res.write(chunkLine({ content: TOKENS[i++] }));
      else {
        clearInterval(timer);
        res.write(chunkLine({}, "stop"));
        res.write(usageLine(TOKENS.length));
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 10);
    res.on("close", () => clearInterval(timer));
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`chaos stub ready on http://127.0.0.1:${PORT}`));
