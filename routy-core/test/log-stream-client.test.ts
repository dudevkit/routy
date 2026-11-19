import { afterEach, describe, expect, it, vi } from "vitest";
import { streamLogs } from "../../routy-ui/src/api/client";

const frame = (event: string, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const response = (body: string) => new Response(body, { status: 200 });

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("log stream client", () => {
  it("resumes from the last id, deduplicates replay, and reports gaps", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(frame("init", { lines: ["first"] }, "epoch:1") + frame("line", { text: "second" }, "epoch:2")))
      .mockResolvedValueOnce(response(frame("line", { text: "second" }, "epoch:2") + frame("line", { text: "third" }, "epoch:3") + frame("gap", {}) + frame("init", { lines: ["latest"] }, "other:1")));
    vi.stubGlobal("fetch", fetchMock);
    const onInit = vi.fn(), onLine = vi.fn(), onGap = vi.fn(), onClose = vi.fn();
    const stop = streamLogs({ onInit, onLine, onGap, onClose });
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(fetchMock.mock.calls[1][0]).toContain("cursor=epoch%3A2");
    expect(onLine.mock.calls).toEqual([["second"], ["third"]]);
    expect(onInit.mock.calls).toEqual([[["first"]], [["latest"]]]);
    expect(onGap).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
    stop();
  });

  it("reconnects after HTTP errors and stops retrying on unsubscribe", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(response(frame("init", { lines: [] }, "epoch:0")));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const stop = streamLogs({ onInit: vi.fn(), onLine: vi.fn(), onClose });
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("reconnects after a network failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(frame("init", { lines: ["recovered"] }, "epoch:0")));
    vi.stubGlobal("fetch", fetchMock);
    const onInit = vi.fn(), onClose = vi.fn();
    const stop = streamLogs({ onInit, onLine: vi.fn(), onClose });
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(onInit).toHaveBeenCalledWith(["recovered"]);
    stop();
  });
});
