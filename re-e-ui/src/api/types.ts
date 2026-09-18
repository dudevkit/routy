/**
 * API seam types — real shapes verified against the live gateway
 * (re-e-core `http/api.mjs` + `db/repos.mjs`) and docs/backend-architecture.md §5.
 * Usage rows come back with snake_case DB column names; that is deliberate and
 * mapped at the UI boundary (see screens/Usage.tsx).
 */

/* ── nodes / upstreams ─────────────────────────────────────────────────────── */
export type NodeStatus = "healthy" | "degraded" | "down" | "disabled";

export interface UpstreamNode {
  id: string;
  name: string;
  baseUrl: string;
  prefix: string;
  /** disabled = node.enabled false · down = breaker open · degraded = failures > 0 */
  status: NodeStatus;
  /** latest successful TTFT for this node, null if none */
  latencyMs: number | null;
  /** 0 until a Test probe runs (the probe caches modelCount on the node) */
  modelCount: number;
  /** always masked — plaintext never returns */
  keyMasked: string;
  lastError?: string;
}

export interface NewNodeInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  prefix: string;
  apiType?: string;
}

/** POST /api/nodes/{id}/test and /api/nodes/test — failures return HTTP 200 + ok:false */
export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  modelCount?: number;
  error?: string;
}

export interface NewConnectionInput {
  name?: string;
  apiKey: string;
}

/** GET/POST /api/nodes/{id}/connections — keys stay masked */
export interface NodeConnection {
  id: string;
  name: string;
  status: string | null;
  priority: number | null;
  keyMasked: string;
  lastError?: string | null;
}

/* ── usage ─────────────────────────────────────────────────────────────────── */
export interface UsageStats {
  requestsToday: number;
  tokens7d: number;
  costUsd7d: number;
  errorRatePct: number;
  /** 0 when no successful request has recorded a TTFT */
  ttftP50Ms: number;
}

/** Real error codes observed: the taxonomy below plus `client_aborted`;
 *  widened to accept anything the backend emits. */
export type ErrorCode =
  | "auth_error"
  | "rate_limited"
  | "upstream_error"
  | "network_error"
  | "all_unavailable"
  | "client_aborted"
  | (string & {});

export interface RecentFailure {
  id: string;
  /** ISO timestamp */
  at: string;
  requestId: string;
  nodeName: string;
  errorCode: ErrorCode;
  message: string;
}

/** GET /api/usage/history — raw usage_events rows (snake_case by design) */
export interface UsageHistoryRow {
  id: number;
  ts: number;
  at: string;
  node_id: string | null;
  connection_id: string | null;
  api_key_id: string | null;
  model: string | null;
  status: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  ttft_ms: number | null;
  duration_ms: number | null;
  error_code: string | null;
}

/** GET /api/usage/details — raw request/response payloads.
 *  NOTE: no usageEventId is exposed (contract request filed) — the UI correlates
 *  request/response by `ts` and links to history rows the same way. */
export interface RequestDetail {
  id: number;
  ts: number;
  kind: "request" | "response" | (string & {});
  truncated: boolean;
  content: string;
}

/* ── gateway ───────────────────────────────────────────────────────────────── */
export interface GatewayInfo {
  online: boolean;
  endpoint: string;
  /** `re_…xxxx` or `—` when no client key exists yet */
  keyMasked: string;
  version: string;
}

export interface GatewayHealth {
  status: string;
  uptimeMs: number;
}

/* ── routing: combos + aliases ─────────────────────────────────────────────── */
export interface Combo {
  id: string;
  name: string;
  /** ordered "model" or "prefix/model" entries — first = primary, rest = fallback */
  models: string[];
  strategy: string;
  stickyLimit: number;
  updatedAt: string;
}

export interface ComboInput {
  name: string;
  models?: string[];
  strategy?: string;
  stickyLimit?: number;
}

/** GET /api/aliases returns a map, not a list */
export type AliasMap = Record<string, string>;

/* ── infra: proxy pools ────────────────────────────────────────────────────── */
export interface ProxyPool {
  id: string;
  name: string;
  kind: string;
  config: { urls?: (string | { url: string })[]; [k: string]: unknown };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPoolInput {
  name: string;
  kind?: string;
  config?: ProxyPool["config"];
  enabled?: boolean;
}

/** POST /api/proxy-pools/{id}/test — probes every url in config.urls */
export interface PoolTestResult {
  ok: boolean;
  results: { url: string; ok: boolean; latencyMs?: number; error?: string }[];
}

/* ── config: settings + client api keys ────────────────────────────────────── */
export interface Settings {
  /** gate: when false the proxy accepts requests without a client key */
  requireApiKey?: boolean;
  /** RTK token-saver compression */
  rtkEnabled?: boolean;
  [k: string]: unknown;
}

export interface ApiKey {
  id: string;
  name: string | null;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

/** POST /api/keys — the only plaintext surface; returned exactly once */
export interface CreatedApiKey {
  id: string;
  key: string;
  name: string | null;
  warning: string;
}

/* ── live logs (SSE) ───────────────────────────────────────────────────────── */
/** One ring-buffer line: compact JSON, redacted. Observed tags include
 *  FETCH, ROUTE, RTK, CHAT, DB, TEST, SHUTDOWN. */
export interface LogRecord {
  t: string;
  level: "debug" | "info" | "warn" | "error" | (string & {});
  tag: string;
  msg: string;
  data?: unknown;
}

/** SSE `init` payload: { lines: string[] } · `line` payload: { text: string } */
export interface LogStreamInit {
  lines: string[];
}

/* ── errors ────────────────────────────────────────────────────────────────── */
export interface ApiErrorBody {
  error: {
    message: string;
    detail?: string;
    retryAfterMs?: number;
    path?: string;
  };
}
