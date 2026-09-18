/**
 * Transport selector: live fetch against re-e-core (default) or the mock
 * preview transport (VITE_API_MODE=mock — models a fresh install, for
 * standalone UI work and empty-state design).
 */
import { api as mockApi, streamLogs as mockStreamLogs } from "./mock";
import { api as liveApi, streamLogs as liveStreamLogs, type LogStreamHandlers, type StreamLevel } from "./client";

const useMock = import.meta.env.VITE_API_MODE === "mock";

/** `typeof liveApi` keeps the mock transport honest: a missing method is a build error. */
export const api: typeof liveApi = useMock ? mockApi : liveApi;
export const streamLogs: (handlers: LogStreamHandlers, level?: StreamLevel) => () => void = useMock
  ? (handlers, level) => mockStreamLogs(handlers, level)
  : liveStreamLogs;
export { ApiRequestError } from "./client";
export type { LogStreamHandlers, StreamLevel };
