/**
 * Live transport — real fetch against re-e-core §5 (same-origin /ui/ in production,
 * Vite dev proxy in development). Selected by transport.ts.
 *
 * Backend conventions verified against the running gateway:
 *  - probes (`/nodes/test`, `/connections/{id}/test`, `/proxy-pools/{id}/test`) return
 *    HTTP 200 with `ok:false` on failure — they are results, not errors
 *  - other failures are non-2xx with `{ error: { message, detail?, retryAfterMs? } }`
 *  - DELETE answers 204
 */
import type {
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
  ModelImportResult,
  NewConnectionInput,
  NewNodeInput,
  NodeConnection,
  NodeModel,
  PoolTestResult,
  ProbeResult,
  ProxyPool,
  ProxyPoolInput,
  RecentFailure,
  RequestDetail,
  Settings,
  TestResult,
  UpstreamNode,
  UsageHistoryRow,
  UsageStats,
} from "./types";

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

/** Explicit generics at each call site — `.then(json)` alone loses `T`. */
const getJson = <T,>(path: string): Promise<T> => fetch(path).then((res) => json<T>(res));
const postJson = <T,>(path: string, body?: unknown): Promise<T> =>
  fetch(path, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => json<T>(res));
const putJson = <T,>(path: string, body: unknown): Promise<T> =>
  fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) =>
    json<T>(res),
  );
const deleteJson = (path: string): Promise<void> =>
  fetch(path, { method: "DELETE" }).then((res) => json<void>(res));

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
 */
export function streamLogs(handlers: LogStreamHandlers, level?: StreamLevel): () => void {
  const source = new EventSource(LOG_STREAM_URL + qs({ level }));

  source.addEventListener("init", (event: MessageEvent) => {
    try {
      handlers.onInit(stringArrayField(JSON.parse(String(event.data)), "lines"));
    } catch {
      /* malformed snapshot frame — skip */
    }
  });

  source.addEventListener("line", (event: MessageEvent) => {
    try {
      const text = textField(JSON.parse(String(event.data)), "text");
      if (text !== undefined) handlers.onLine(text);
    } catch {
      /* malformed frame — skip */
    }
  });

  source.addEventListener("clear", () => handlers.onClear?.());

  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onClose?.();
  return () => source.close();
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

  /* api keys — per-key probe (P6) */
  testConnectionKey: (connectionId: string): Promise<KeyTestResult> =>
    postJson<KeyTestResult>(`/api/connections/${enc(connectionId)}/test`, {}),
  testAllKeys: (id: string): Promise<{ node: string; tested: number; ok: number; results: KeyTestResult[] }> =>
    postJson(`/api/nodes/${enc(id)}/keys/test`, {}),

  listConnections: (id: string): Promise<NodeConnection[]> => getJson<NodeConnection[]>(`/api/nodes/${enc(id)}/connections`),
  addConnection: (id: string, input: NewConnectionInput): Promise<NodeConnection> =>
    postJson<NodeConnection>(`/api/nodes/${enc(id)}/connections`, input),
  updateConnection: (id: string, patch: { name?: string; status?: string; priority?: number }): Promise<NodeConnection> =>
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

  /* proxy pools */
  listPools: (): Promise<ProxyPool[]> => getJson<ProxyPool[]>("/api/proxy-pools"),
  createPool: (input: ProxyPoolInput): Promise<ProxyPool> => postJson<ProxyPool>("/api/proxy-pools", input),
  updatePool: (id: string, patch: Partial<ProxyPoolInput>): Promise<ProxyPool> =>
    putJson<ProxyPool>(`/api/proxy-pools/${enc(id)}`, patch),
  deletePool: (id: string): Promise<void> => deleteJson(`/api/proxy-pools/${enc(id)}`),
  testPool: (id: string): Promise<PoolTestResult> => postJson<PoolTestResult>(`/api/proxy-pools/${enc(id)}/test`),

  /* logs */
  /** clears the server ring and notifies every open stream (`clear` event) */
  clearLogs: (): Promise<{ ok: boolean }> => postJson<{ ok: boolean }>("/api/logs/clear"),
};
