// RE-E stream utilities — bounded log buffer + incremental usage tracker + pump.
// Replaces upstream's unbounded full-response accumulation (stream.js:66-68):
//   - LogBuffer: hard cap on retained text; counts beyond the cap, truncates log only.
//   - UsageTracker: token estimation incrementally (chars/4 heuristic); exact numbers
//     override estimates when the upstream reports usage.
import { SseParser, formatSse } from "./parser.mjs";

export const DEFAULT_LOG_CAP_BYTES = 2 * 1024 * 1024;

export class LogBuffer {
  constructor({ capBytes = DEFAULT_LOG_CAP_BYTES } = {}) {
    this.capBytes = capBytes;
    this.parts = [];
    this.retained = 0;
    this.total = 0;
  }
  append(text) {
    if (!text) return;
    this.total += Buffer.byteLength(text, "utf8");
    if (this.retained >= this.capBytes) return;
    const remaining = this.capBytes - this.retained;
    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    this.parts.push(slice);
    this.retained += Buffer.byteLength(slice, "utf8");
  }
  get text() { return this.parts.join(""); }
  get truncated() { return this.total > this.retained; }
}

// ~4 chars/token heuristic; good enough for estimation, exact values override.
export const estimateTokens = (text) => Math.ceil((text || "").length / 4);

export class UsageTracker {
  constructor({ promptText = "" } = {}) {
    this.promptTokens = estimateTokens(promptText);
    this.completionTokens = 0;
    this.exact = false;
    this.ttftMs = null;
    this.firstByteAt = null;
  }
  observeFirstByte(t0) {
    if (this.firstByteAt === null) {
      this.firstByteAt = Date.now();
      this.ttftMs = this.firstByteAt - t0;
    }
  }
  observeChunk(data) {
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.usage && typeof parsed.usage === "object") {
        if (Number.isFinite(parsed.usage.prompt_tokens)) {
          this.promptTokens = parsed.usage.prompt_tokens;
          this.exact = true;
        }
        if (Number.isFinite(parsed.usage.completion_tokens)) {
          this.completionTokens = parsed.usage.completion_tokens;
          this.exact = true;
        }
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && !this.exact) this.completionTokens += estimateTokens(delta);
    } catch { /* non-JSON data line — ignore for usage */ }
  }
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/**
 * Pump an upstream fetch Response into a Node ServerResponse as SSE.
 * - Client disconnect aborts upstream via signal.
 * - transform(event, data-frame) → string[] of wire-ready frames (or null to skip).
 * - Backpressure: awaits drain when socket buffer fills.
 * - trailingDone: emit a second [DONE] after the stream (upstream parity quirk).
 * Returns { clientGone }.
 */
export async function pumpSse({ upstream, res, signal, t0, transform = null, usage = null, logBuffer = null, maxEmptyReads = 4, trailingDone = false }) {
  res.writeHead(upstream.status, SSE_HEADERS);
  const parser = new SseParser();
  const reader = upstream.body.getReader();
  let clientGone = false;
  const onClose = () => { clientGone = true; };
  res.on("close", onClose);

  let emptyReads = 0;
  try {
    while (true) {
      if (clientGone) {
        signal?.abort?.();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        emptyReads = 0;
        usage?.observeFirstByte(t0);
        for (const frame of parser.push(value)) {
          usage?.observeChunk(frame.data);
          logBuffer?.append(frame.data + "\n");
          const frames = transform ? transform(frame) : [formatSse(frame.event, frame.data)];
          for (const out of frames) {
            if (!res.write(out)) await onceDrain(res);
          }
        }
      } else {
        // guard: some runtimes deliver empty reads; don't spin forever
        if (++emptyReads > maxEmptyReads) break;
      }
    }
    for (const frame of parser.end()) {
      const frames = transform ? transform(frame) : [formatSse(frame.event, frame.data)];
      for (const out of frames) {
        if (!res.write(out)) await onceDrain(res);
      }
    }
    // Upstream parity: 9Router's transform+flush both emit [DONE] — clients stop at
    // the first one, so the duplicate is benign. Keep it for byte-identical output.
    if (trailingDone && !res.writableEnded && !clientGone) res.write("data: [DONE]\n\n");
  } catch (err) {
    if (!clientGone) {
      // upstream died mid-stream: emit a terminal error frame so the client doesn't hang
      const detail = String(err?.message || err).slice(0, 200);
      if (!res.writableEnded) {
        if (!res.write(formatSse("error", JSON.stringify({ error: { message: "upstream_stream_failed", detail } })))) {
          await onceDrain(res);
        }
      }
    }
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
  return { clientGone };
}

function onceDrain(res) {
  return new Promise((resolve) => res.once("drain", resolve));
}
