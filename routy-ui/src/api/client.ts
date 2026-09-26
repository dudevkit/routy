/**
 * Live transport — real fetch against routy-core §5 (same-origin /ui/ in production,
 * Vite dev proxy in development). Selected by transport.ts.
 *
 * Backend conventions verified against the running gateway:
 *  - probes (`/nodes/test`, `/connections/{id}/test`, `/proxy-pools/{id}/test`) return
 *    HTTP 200 with `ok:false` on failure — they are results, not errors
 *  - other failures are non-2xx with `{ error: { message, detail?, retryAfterMs? } }`
 *  - DELETE answers 204
 */
import type {
  CliTool,
  UpdateApplyResult,
  UpdateState,
  BatchConnectionInput,
  BatchConnectionResult,
  AliasMap,
  ApiKey,
  Combo,
  ComboInput,
  CreatedApiKey,
  GatewayHealth,
  GatewayInfo,
  KeyTestResult,
  ModelBulkAction,
  ModelBulkResult,
  ModelImportResult,
  NewConnectionInput,
  NewNodeInput,
  NodeConnection,
  NodeModel,
  AddEntriesResult,
  EntryTestOutcome,
  PoolTestResult,
  ProbeResult,
  ProxyPool,
  ProxyPoolEntry,
  ProxyPoolInput,
  RecentFailure,
  RequestDetail,
  Settings,
  TestResult,
  UpstreamNode,
  UsageHistoryRow,
  UsageStats,
} from "./types";
import { signalUnauthorized } from "./auth";

/** Structured API failure: message + detail + retry hint, ready for the UI to render. */
export class ApiRequestError extends Error {
  status: number;
  detail?: string;
  retryAfterMs?: number;

  constructor(status: number, message: string, detail?: string, retryAfterMs?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * JSON.parse hands back `unknown`. These readers verify shape before touching a
 * field, so nothing below performs unvalidated member access on external data.
 */
function recordOf(v: unknown): Record<string, unknown> | null {
  // the typeof check guarantees an object; TS cannot express that structurally
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function textField(source: unknown, key: string): string | undefined {
  const raw = recordOf(source)?.[key];
  return typeof raw === "string" ? raw : undefined;
}

function numberField(source: unknown, key: string): number | undefined {
  const raw = recordOf(source)?.[key];
  return typeof raw === "number" ? raw : undefined;
}

function stringArrayField(source: unknown, key: string): string[] {
  const raw = recordOf(source)?.[key];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // The token is missing, wrong, or was rotated. The shell listens for this and
    // puts the gate up, rather than every screen rendering its own "failed to load".
    if (res.status === 401) signalUnauthorized();
    let message = `HTTP ${res.status}`;
    let detail: string | undefined;
    let retryAfterMs: number | undefined;
    try {
      const body: unknown = await res.json();
      const err = recordOf(recordOf(body)?.error);
      message = (err && textField(err, "message")) || message;
      detail = err ? textField(err, "detail") : undefined;
      retryAfterMs = err ? numberField(err, "retryAfterMs") : undefined;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, message, detail, retryAfterMs);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Every mutating request carries this header. It is not authentication — it forces a
 * CORS preflight, which a cross-origin page cannot satisfy, so a hostile tab cannot
 * drive the gateway by POSTing to 127.0.0.1. Endpoints that care reject its absence.
 *
 * Auth itself needs nothing here: the session is an HttpOnly cookie, which the browser
 * attaches to every same-origin request without being asked.
 */
const ACTION = { "x-routy-action": "1" };

/** Explicit generics at each call site — `.then(json)` alone loses `T`. */
const getJson = <T,>(path: string): Promise<T> => fetch(path).then((res) => json<T>(res));
const postJson = <T,>(path: string, body?: unknown): Promise<T> =>
  fetch(path, {
    method: "POST",
    headers: body === undefined ? { ...ACTION } : { ...ACTION, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => json<T>(res));
const putJson = <T,>(path: string, body: unknown): Promise<T> =>
  fetch(path, {
    method: "PUT",
    headers: { ...ACTION, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => json<T>(res));
const deleteJson = (path: string): Promise<void> =>
  fetch(path, { method: "DELETE", headers: { ...ACTION } }).then((res) => json<void>(res));

const qs = (params: Record<string, string | number | undefined>) => {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") sp.set(key, String(value));
  const q = sp.toString();
  return q ? `?${q}` : "";
};

const enc = encodeURIComponent;

export const LOG_STREAM_URL = "/api/logs/stream";

export interface LogStreamHandlers {
  /** ring-buffer snapshot (up to 200 compact JSON lines) */
  onInit: (lines: string[]) => void;
  /** one live line, still a JSON string — parse at render time */
  onLine: (text: string) => void;
  /** server-side ring was cleared (POST /api/logs/clear) — drop local buffer */
  onClear?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/** Lowest level the server should stream; anything above it is filtered in-view. */
export type StreamLevel = "debug" | "info" | "warn" | "error";

/**
 * Subscribe to the SSE log stream; returns an unsubscribe function. `level` maps
 * to the server-side `?level=` filter, so a console watching only warn/error does
 * not pay for debug traffic over the wire.
 *
 * fetch plus a hand-rolled SSE parse, rather than EventSource: EventSource cannot
 * send an Authorization header, and from any device other than the gateway's own,
 * /api needs one — so the Live Console was the one screen that stayed broken even
 * after the token worked everywhere else. The wire format is identical.
 */
export function streamLogs(handlers: LogStreamHandlers, level?: StreamLevel): () => void {
  const controller = new AbortController();
  let closed = false;

  const emit = (event: string, data: string) => {
    if (event === "init") {
      try {
        handlers.onInit(stringArrayField(JSON.parse(data), "lines"));
      } catch {
        /* malformed snapshot frame — skip */
      }
    } else if (event === "line") {
      try {
        const text = textField(JSON.parse(data), "text");
        if (text !== undefined) handlers.onLine(text);
      } catch {
        /* malformed frame — skip */
      }
    } else if (event === "clear") {
      handlers.onClear?.();
    }
  };

  void (async () => {
    try {
      const res = await fetch(LOG_STREAM_URL + qs({ level }), {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401) signalUnauthorized();
        if (!closed) handlers.onClose?.();
        return;
      }
      handlers.onOpen?.();

      const reader = res.body?.getReader();
      if (!reader) {
        if (!closed) handlers.onClose?.();
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        for (let split = buffer.indexOf("\n\n"); split >= 0; split = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) emit(event, data.join("\n"));
        }
      }
    } catch {
      /* aborted on unsubscribe, or the connection dropped */
    }
    if (!closed) handlers.onClose?.();
  })();

  return () => {
    closed = true;
    controller.abort();
  };
}

export const api = {
  /* nodes / upstreams */
  listNodes: (): Promise<UpstreamNode[]> => getJson<UpstreamNode[]>("/api/nodes"),
  addNode: (input: NewNodeInput): Promise<UpstreamNode> => postJson<UpstreamNode>("/api/nodes", input),
  /** round-2: rename, fix baseUrl/prefix/apiType, rotate apiKey, enable/disable */
  updateNode: (id: string, patch: Partial<NewNodeInput> & { enabled?: boolean; apiType?: string }): Promise<UpstreamNode> =>
    putJson<UpstreamNode>(`/api/nodes/${enc(id)}`, patch),
  removeNode: (id: string): Promise<void> => deleteJson(`/api/nodes/${enc(id)}`),
  resetBreaker: (id: string): Promise<UpstreamNode> => postJson<UpstreamNode>(`/api/nodes/${enc(id)}/reset`),
  testConnection: (input: { baseUrl: string; apiKey?: string }): Promise<TestResult> =>
    postJson<TestResult>("/api/nodes/test", input),

  /* models — discovery-only list, plus per-model probes (P6) */
  listModels: (id: string): Promise<{ node: string; models: NodeModel[]; count: number }> =>
    getJson(`/api/nodes/${enc(id)}/models`),
  addModel: (id: string, input: { model: string; enabled?: boolean }): Promise<NodeModel> =>
    postJson<NodeModel>(`/api/nodes/${enc(id)}/models`, input),
  updateModel: (id: string, modelId: string, patch: { model?: string; enabled?: boolean }): Promise<NodeModel> =>
    putJson<NodeModel>(`/api/nodes/${enc(id)}/models/${enc(modelId)}`, patch),
  removeModel: (id: string, modelId: string): Promise<void> => deleteJson(`/api/nodes/${enc(id)}/models/${enc(modelId)}`),
  importModels: (id: string, connectionId?: string): Promise<ModelImportResult> =>
    postJson<ModelImportResult>(`/api/nodes/${enc(id)}/models/import`, connectionId ? { connectionId } : {}),
  testModel: (id: string, modelId: string, connectionId?: string): Promise<NodeModel & { result: ProbeResult }> =>
    postJson(`/api/nodes/${enc(id)}/models/${enc(modelId)}/test${qs({ connectionId })}`, {}),
  /** Bulk hide/show/delete/test a selection — one round trip, bounded concurrency. */
  bulkModels: (id: string, input: { ids: string[]; action: ModelBulkAction }): Promise<ModelBulkResult> =>
    postJson<ModelBulkResult>(`/api/nodes/${enc(id)}/models/bulk`, input),

  /* api keys — per-key probe (P6) */
  testConnectionKey: (connectionId: string): Promise<KeyTestResult> =>
    postJson<KeyTestResult>(`/api/connections/${enc(connectionId)}/test`, {}),
  testAllKeys: (id: string): Promise<{ node: string; tested: number; ok: number; results: KeyTestResult[] }> =>
    postJson(`/api/nodes/${enc(id)}/keys/test`, {}),

  listConnections: (id: string): Promise<NodeConnection[]> => getJson<NodeConnection[]>(`/api/nodes/${enc(id)}/connections`),
  addConnection: (id: string, input: NewConnectionInput): Promise<NodeConnection> =>
    postJson<NodeConnection>(`/api/nodes/${enc(id)}/connections`, input),
  updateConnection: (id: string, patch: { name?: string; status?: string; priority?: number; proxyPoolId?: string | null }): Promise<NodeConnection> =>
    putJson<NodeConnection>(`/api/connections/${enc(id)}`, patch),
  deleteConnection: (id: string): Promise<void> => deleteJson(`/api/connections/${enc(id)}`),
  batchAddConnections: (id: string, input: BatchConnectionInput): Promise<BatchConnectionResult> =>
    postJson<BatchConnectionResult>(`/api/nodes/${enc(id)}/connections/batch`, input),

  /* usage */
  getStats: (): Promise<UsageStats> => getJson<UsageStats>("/api/usage/stats"),
  getFailures: (limit = 20): Promise<RecentFailure[]> => getJson<RecentFailure[]>(`/api/usage/failures${qs({ limit })}`),
  getHistory: (params: { since?: number; limit?: number } = {}): Promise<UsageHistoryRow[]> =>
    getJson<UsageHistoryRow[]>(`/api/usage/history${qs(params)}`),
  getDetails: (limit = 50, usageEventId?: number): Promise<RequestDetail[]> =>
    getJson<RequestDetail[]>(`/api/usage/details${qs({ limit, usageEventId })}`),

  /* gateway */
  getGateway: (): Promise<GatewayInfo> => getJson<GatewayInfo>("/api/gateway"),
  getHealth: (): Promise<GatewayHealth> => getJson<GatewayHealth>("/api/health"),

  /* settings + client api keys */
  getSettings: (): Promise<Settings> => getJson<Settings>("/api/settings"),
  putSettings: (patch: Settings): Promise<Settings> => putJson<Settings>("/api/settings", patch),
  listKeys: (): Promise<ApiKey[]> => getJson<ApiKey[]>("/api/keys"),
  createKey: (name?: string): Promise<CreatedApiKey> => postJson<CreatedApiKey>("/api/keys", { name }),
  /** round-2: revoke without deleting (backend returns 204) */
  setKeyEnabled: (id: string, enabled: boolean): Promise<void> => putJson<void>(`/api/keys/${enc(id)}`, { enabled }),
  removeKey: (id: string): Promise<void> => deleteJson(`/api/keys/${enc(id)}`),

  /* routing: combos + aliases */
  listCombos: (): Promise<Combo[]> => getJson<Combo[]>("/api/combos"),
  createCombo: (input: ComboInput): Promise<Combo> => postJson<Combo>("/api/combos", input),
  updateCombo: (id: string, patch: Partial<ComboInput>): Promise<Combo> => putJson<Combo>(`/api/combos/${enc(id)}`, patch),
  deleteCombo: (id: string): Promise<void> => deleteJson(`/api/combos/${enc(id)}`),
  listAliases: (): Promise<AliasMap> => getJson<AliasMap>("/api/aliases"),
  setAlias: (input: { alias: string; target: string }): Promise<{ alias: string; target: string }> =>
    putJson<{ alias: string; target: string }>(`/api/aliases/${enc(input.alias)}`, { target: input.target }),
  deleteAlias: (alias: string): Promise<void> => deleteJson(`/api/aliases/${enc(alias)}`),

  /* proxy pools — a pool is a fleet of exits (see the type for the shape) */
  listPools: (): Promise<ProxyPool[]> => getJson<ProxyPool[]>("/api/proxy-pools"),
  createPool: (input: ProxyPoolInput): Promise<ProxyPool> => postJson<ProxyPool>("/api/proxy-pools", input),
  updatePool: (id: string, patch: Partial<ProxyPoolInput>): Promise<ProxyPool> =>
    putJson<ProxyPool>(`/api/proxy-pools/${enc(id)}`, patch),
  deletePool: (id: string): Promise<void> => deleteJson(`/api/proxy-pools/${enc(id)}`),
  testPool: (id: string): Promise<PoolTestResult> => postJson<PoolTestResult>(`/api/proxy-pools/${enc(id)}/test`),
  /** exits: `urls` accepts the paste box's text as well as an array */
  addPoolEntries: (id: string, urls: string | string[]): Promise<AddEntriesResult> =>
    postJson<AddEntriesResult>(`/api/proxy-pools/${enc(id)}/entries`, { urls }),
  updatePoolEntry: (id: string, patch: { url?: string; enabled?: boolean }): Promise<ProxyPoolEntry> =>
    putJson<ProxyPoolEntry>(`/api/proxy-pool-entries/${enc(id)}`, patch),
  deletePoolEntry: (id: string): Promise<void> => deleteJson(`/api/proxy-pool-entries/${enc(id)}`),
  testPoolEntry: (id: string): Promise<EntryTestOutcome> => postJson<EntryTestOutcome>(`/api/proxy-pool-entries/${enc(id)}/test`),
  mergePools: (targetId: string, poolIds: string[]): Promise<ProxyPool> =>
    postJson<ProxyPool>("/api/proxy-pools/merge", { targetId, poolIds }),
  resetPoolHealth: (id: string): Promise<{ cleared: number; pool: ProxyPool }> =>
    postJson<{ cleared: number; pool: ProxyPool }>(`/api/proxy-pools/${enc(id)}/reset-health`),

  /* cli tools */
  listCliTools: (): Promise<{ tools: CliTool[] }> => getJson<{ tools: CliTool[] }>("/api/cli-tools"),
  connectCliTool: (id: string, input: { baseUrl?: string; apiKey?: string | null; model?: string | null }): Promise<{ status: CliTool }> =>
    postJson<{ status: CliTool }>(`/api/cli-tools/${enc(id)}/connect`, input),
  disconnectCliTool: (id: string): Promise<{ status: CliTool }> =>
    postJson<{ status: CliTool }>(`/api/cli-tools/${enc(id)}/disconnect`),

  /* updates */
  getUpdates: (): Promise<UpdateState> => getJson<UpdateState>("/api/updates"),
  checkUpdates: (): Promise<UpdateState> => postJson<UpdateState>("/api/updates/check"),
  dismissUpdate: (version: string | null): Promise<UpdateState> =>
    postJson<UpdateState>("/api/updates/dismiss", { version }),
  applyUpdate: (): Promise<UpdateApplyResult> => postJson<UpdateApplyResult>("/api/updates/apply"),

  /* logs */
  /** clears the server ring and notifies every open stream (`clear` event) */
  clearLogs: (): Promise<{ ok: boolean }> => postJson<{ ok: boolean }>("/api/logs/clear"),
};
