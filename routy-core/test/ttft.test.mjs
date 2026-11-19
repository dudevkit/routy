import { describe, it, expect, vi } from "vitest";
import { UsageTracker } from "../core/sse/stream.mjs";

describe("time to first generated output", () => {
  it("ignores headers and terminal frames, then records the first content once", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      const usage = new UsageTracker();
      clock.mockReturnValue(1100);
      usage.observeFirstByte(1000);
      expect(usage.ttftMs).toBeNull();
      expect(usage.observeOutput('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', 1000)).toBe(false);
      clock.mockReturnValue(1600);
      expect(usage.observeOutput('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 1000)).toBe(true);
      expect(usage.ttftMs).toBe(600);
      clock.mockReturnValue(2000);
      expect(usage.observeOutput('data: {"choices":[{"delta":{"content":"again"}}]}\n\n', 1000)).toBe(false);
      expect(usage.ttftMs).toBe(600);
    } finally { clock.mockRestore(); }
  });
});
