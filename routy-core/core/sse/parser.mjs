// routy SSE frame parser — byte-safe (multi-byte UTF-8 split across chunks),
// constant-memory state, bounded buffer. Feed bytes; receive {event, data} frames.
export class SseParser {
  constructor({ maxBufferBytes = 1024 * 1024 } = {}) {
    this.decoder = new TextDecoder("utf-8", { fatal: false, stream: true });
    this.buffer = "";
    this.maxBufferBytes = maxBufferBytes;
    this.overflowed = false;
  }

  /**
   * Push a Uint8Array/Buffer chunk; returns array of frames {event: string|null, data: string}.
   * Frames are complete SSE events (separated by a blank line).
   */
  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferBytes) {
      // A single frame exceeding 1MB is a protocol violation — drop it, keep parsing future frames.
      this.buffer = "";
      this.overflowed = true;
      return [];
    }
    return this.#drainFrames();
  }

  /** Flush any trailing partial frame at stream end. */
  end() {
    const tail = this.decoder.decode(); // flush multi-byte residue
    this.buffer += tail;
    const frames = this.#drainFrames();
    if (this.buffer.trim().length > 0) {
      frames.push({ event: null, data: this.buffer.trim(), incomplete: true });
      this.buffer = "";
    }
    return frames;
  }

  #drainFrames() {
    const frames = [];
    let idx;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1 || (idx = this.buffer.indexOf("\r\n\r\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + (this.buffer.startsWith("\r\n", idx) ? 4 : 2));
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseFrame(raw) {
  let event = null;
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // SSE comment/heartbeat
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
  }
  if (dataLines.length === 0 && event === null) return null;
  return { event, data: dataLines.join("\n") };
}

/** Serialize a frame back to wire format (single emit per event). */
export function formatSse(event, data) {
  return event ? `event: ${event}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
}
