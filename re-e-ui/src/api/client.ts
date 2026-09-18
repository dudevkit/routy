/**
 * Live transport — real fetch against re-e-core §5 (same-origin /ui/ in production,
 * Vite dev proxy in development). Selected by transport.ts.
 *
 * Backend conventions verified against the running gateway:
 *  - probes (`/nodes/test`, `/nodes/{id}/test`, `/proxy-pools/{id}/test`) return
 *    HTTP 200 with `ok:false` on failure — they are results, not errors
 *  - other failures are non-2xx with `{ error: { message, detail?, retryAfterMs? } }`
 *  - DELETE answers 204
 */
import type {
  AliasMap,
  ApiKey,
  Combo,
  ComboInput,
  CreatedApiKey,
  GatewayHealth,
  GatewayInfo,
  NewConnectionInput,
  NewNodeInput,
  NodeConnection,
  PoolTestResult,
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
  onOpen?: () => void;
  onClose?: () => void;
}

/** Subscribe to the SSE log stream; returns an unsubscribe function. */
export function streamLogs(handlers: LogStreamHandlers): () => void {
  const source = new EventSource(LOG_STREAM_URL);

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

  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onClose?.();
  return () => source.close();
}

export const api = {
  /* nodes / upstreams */
  listNodes: (): Promise<UpstreamNode[]> => getJson<UpstreamNode[]>("/api/nodes"),
  addNode: (input: NewNodeInput): Promise<UpstreamNode> => postJson<UpstreamNode>("/api/nodes", input),
  removeNode: (id: string): Promise<void> => deleteJson(`/api/nodes/${enc(id)}`),
  resetBreaker: (id: string): Promise<UpstreamNode> => postJson<UpstreamNode>(`/api/nodes/${enc(id)}/reset`),
  testNode: (id: string): Promise<TestResult> => postJson<TestResult>(`/api/nodes/${enc(id)}/test`),
  testConnection: (input: { baseUrl: string; apiKey?: string }): Promise<TestResult> =>
    postJson<TestResult>("/api/nodes/test", input),
  listConnections: (id: string): Promise<NodeConnection[]> => getJson<NodeConnection[]>(`/api/nodes/${enc(id)}/connections`),
  addConnection: (id: string, input: NewConnectionInput): Promise<NodeConnection> =>
    postJson<NodeConnection>(`/api/nodes/${enc(id)}/connections`, input),

  /* usage */
  getStats: (): Promise<UsageStats> => getJson<UsageStats>("/api/usage/stats"),
  getFailures: (limit = 20): Promise<RecentFailure[]> => getJson<RecentFailure[]>(`/api/usage/failures${qs({ limit })}`),
  getHistory: (params: { since?: number; limit?: number } = {}): Promise<UsageHistoryRow[]> =>
    getJson<UsageHistoryRow[]>(`/api/usage/history${qs(params)}`),
  getDetails: (limit = 50): Promise<RequestDetail[]> => getJson<RequestDetail[]>(`/api/usage/details${qs({ limit })}`),

  /* gateway */
  getGateway: (): Promise<GatewayInfo> => getJson<GatewayInfo>("/api/gateway"),
  getHealth: (): Promise<GatewayHealth> => getJson<GatewayHealth>("/api/health"),

  /* settings + client api keys */
  getSettings: (): Promise<Settings> => getJson<Settings>("/api/settings"),
  putSettings: (patch: Settings): Promise<Settings> => putJson<Settings>("/api/settings", patch),
  listKeys: (): Promise<ApiKey[]> => getJson<ApiKey[]>("/api/keys"),
  createKey: (name?: string): Promise<CreatedApiKey> => postJson<CreatedApiKey>("/api/keys", { name }),
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
};
