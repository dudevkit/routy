// routy stream utilities — bounded log buffer + incremental usage tracker + pump.
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
 * - idleTimeoutMs: stall watchdog — abort + error frame when the upstream goes
 *   silent for that long (0 disables).
 * Returns { clientGone, completed, stalled, errored } — errored means the upstream
 * broke (stall or mid-stream death) and the node should count a breaker failure.
 * `completed` means the client was handed everything there was to hand, which is what
 * separates a real walk-away from a client that hung up the moment it was done with us.
 */

/** Thrown internally when the upstream goes silent past the idle budget. */
class StallError extends Error {
  constructor() { super("upstream stream stalled"); this.name = "StallError"; }
}

/**
 * Does this outgoing frame END the answer?
 *
 * Checked on what goes TO the client, so "the client got a terminal" stays a claim
 * about the client's stream rather than the upstream's. Both dialects count: OpenAI
 * sends a non-null finish_reason then [DONE]; Anthropic ends on message_delta /
 * message_stop.
 */
export function isTerminalFrame(text) {
  if (!text) return false;
  const match = /^data:[ \t]*(.*)$/m.exec(text);
  if (!match) return false; // event-only frame (message_start, ping, ...)
  const payload = match[1].trim();
  if (payload === "[DONE]") return true;
  if (!payload.startsWith("{")) return false;
  try {
    const obj = JSON.parse(payload);
    if (obj?.choices?.some?.((c) => c && c.finish_reason)) return true;
    return obj?.type === "message_delta" || obj?.type === "message_stop";
  } catch {
    return false; // partial or non-JSON data line
  }
}

export async function pumpSse({ upstream, res, signal, t0, transform = null, flushFrames = null, usage = null, logBuffer = null, maxEmptyReads = 4, trailingDone = false, idleTimeoutMs = 0 }) {
  res.writeHead(upstream.status, SSE_HEADERS);
  const parser = new SseParser();
  const reader = upstream.body.getReader();
  let clientGone = false;
  // Set once the client has been handed the end of the answer, or the upstream stream
  // ran out on its own -- either way there is nothing left to deliver. Clients such as
  // CLI agents stop reading the instant they see finish_reason / [DONE] and close the
  // socket, so clientGone on its own cannot tell "walked away mid-generation" from
  // "got the whole answer and hung up first". Conflating them charged every completed
  // request as an abort: the node was never credited, its latency was never learned,
  // and a healthy provider filled the Recent failures list.
  let completed = false;
  const onClose = () => { clientGone = true; };
  res.on("close", onClose);
  const write = (out) => {
    const more = res.write(out);
    if (!completed && isTerminalFrame(out)) completed = true;
    return more;
  };

  // Stall watchdog: an upstream that stops sending without closing the socket
  // would hang the client forever. Bound the wait between chunks (first byte
  // included). idleTimeoutMs = 0 disables it.
  let stalled = false;
  let errored = false;
  const readWithIdle = async () => {
    if (!idleTimeoutMs) return reader.read();
    let timer;
    const idle = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StallError()), idleTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } finally {
      clearTimeout(timer);
    }
  };

  let emptyReads = 0;
  let frames = 0;
  let bytes = 0;
  try {
    while (true) {
      if (clientGone) {
        signal?.abort?.();
        break;
      }
      const { done, value } = await readWithIdle();
      // The upstream ended by itself: there is nothing left to hand the client, so a
      // hangup from here on is the client finishing, not us being cut off.
      if (done) { completed = true; break; }
      if (value && value.length > 0) {
        emptyReads = 0;
        usage?.observeFirstByte(t0);
        for (const frame of parser.push(value)) {
          usage?.observeChunk(frame.data);
          logBuffer?.append(frame.data + "\n");
          const outFrames = transform ? transform(frame) : [formatSse(frame.event, frame.data)];
          for (const out of outFrames) {
            frames++; bytes += out.length;
            if (!write(out)) await onceDrain(res);
          }
        }
      } else {
        // guard: some runtimes deliver empty reads; don't spin forever
        if (++emptyReads > maxEmptyReads) break;
      }
    }
    for (const frame of parser.end()) {
      const outFrames = transform ? transform(frame) : [formatSse(frame.event, frame.data)];
      for (const out of outFrames) {
        frames++; bytes += out.length;
        if (!write(out)) await onceDrain(res);
      }
    }
    // Translator tail flush (e.g. claude message_stop) — translate mode only
    if (flushFrames) {
      for (const out of flushFrames() || []) {
        if (!res.writableEnded && !write(out)) await onceDrain(res);
      }
    }
    // Upstream parity: 9Router's transform+flush both emit [DONE] — clients stop at
    // the first one, so the duplicate is benign. Keep it for byte-identical output.
    if (trailingDone && !res.writableEnded && !clientGone) write("data: [DONE]\n\n");
  } catch (err) {
    if (err instanceof StallError) {
      stalled = true;
      errored = true;
      try { await reader.cancel(); } catch { /* already gone */ }
      signal?.abort?.();
      if (!clientGone && !res.writableEnded) {
        const detail = `no upstream data for ${idleTimeoutMs}ms`;
        if (!res.write(formatSse("error", JSON.stringify({ error: { message: "upstream_stalled", detail, retryAfterMs: null } })))) {
          await onceDrain(res);
        }
      }
    } else if (!clientGone) {
      // upstream died mid-stream: emit a terminal error frame so the client doesn't hang
      errored = true;
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
  return { clientGone, completed, stalled, errored, frames, bytes, durationMs: Date.now() - t0 };
}

function onceDrain(res) {
  return new Promise((resolve) => res.once("drain", resolve));
}
