/**
 * Transport selector: live fetch against re-e-core (default) or the mock
 * preview transport (VITE_API_MODE=mock — models a fresh install, for
 * standalone UI work and empty-state design).
 */
import { api as mockApi, streamLogs as mockStreamLogs } from "./mock";
import { api as liveApi, streamLogs as liveStreamLogs, type LogStreamHandlers } from "./client";

const useMock = import.meta.env.VITE_API_MODE === "mock";

export const api = useMock ? mockApi : liveApi;
export const streamLogs: (handlers: LogStreamHandlers) => () => void = useMock ? mockStreamLogs : liveStreamLogs;
export { ApiRequestError } from "./client";
export type { LogStreamHandlers };
