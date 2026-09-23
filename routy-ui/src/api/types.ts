/**
 * API seam types — real shapes verified against the live gateway
 * (routy-core `http/api.mjs` + `db/repos.mjs`) and docs/backend-architecture.md §5.
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
  models: string[];
  /** the node's config bag: pricing, pool tuning, retry overrides, cached models */
  data: NodeData;
  /** always masked - plaintext never returns */
  keyMasked: string;
  lastError?: string;
}

export interface NewNodeInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  prefix: string;
  apiType?: string;
  /** config bag: pricing, pool tuning, stall watchdog. Merges on update. */
  data?: NodeData;
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

/** POST /api/nodes/{id}/connections/batch — N keys → N connections in one call */
export interface BatchConnectionInput {
  /** each entry may carry its own label; unlabelled keys are auto-named */
  entries: { name?: string; apiKey: string }[];
  /** optional label prefix applied to entries that have none */
  name?: string;
  priority?: number;
}

export interface BatchConnectionResult {
  created: number;
  connections: { id: string; name: string; keyMasked: string; priority: number }[];
}

/** GET/POST /api/nodes/{id}/connections — keys stay masked */
export interface NodeConnection {
  id: string;
  name: string;
  status: string | null;
  priority: number | null;
  keyMasked: string;
  lastError?: string | null;
  /** last probe of this key alone (P6) — diagnostics, not traffic */
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestTtftMs?: number | null;
}

/* ── usage ─────────────────────────────────────────────────────────────────── */
export interface UsageStats {
  requestsToday: number;
  tokens7d: number;
  costUsd7d: number;
  /** metered spend since local midnight — what the budget ceiling enforces against */
  costUsdToday: number;
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
 *  Round 2 exposes `usageEventId`, so the drawer correlates a payload pair to its
 *  history row exactly instead of by `ts` (which can collide under concurrency). */
export interface RequestDetail {
  id: number;
  ts: number;
  usageEventId?: number | null;
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

/** Per-node model row (P6). `enabled`/`stale` affect discovery only — routing
 *  passes any `<prefix>/<model>` through regardless. */
export interface NodeModel {
  id: string;
  nodeId: string;
  model: string;
  source: "imported" | "manual";
  enabled: boolean;
  /** was imported, no longer listed upstream — kept, never silently deleted */
  stale: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestTtftMs: number | null;
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of a single probe — diagnostics, never recorded as traffic. */
export interface ProbeResult {
  ok: boolean;
  ttftMs: number | null;
  latencyMs: number;
  error: string | null;
}

/** Per-key probe outcome. */
export interface KeyTestResult {
  connectionId: string;
  name?: string;
  ok: boolean;
  latencyMs: number;
  modelCount: number;
  error: string | null;
}

/** Import summary: manual rows are kept, vanished imports go stale. */
export interface ModelImportResult {
  imported: number;
  kept: number;
  stale: number;
  listed: number;
  latencyMs: number;
  models: NodeModel[];
}

/** Bulk selection actions available on the Models tab. */
export type ModelBulkAction = "hide" | "show" | "delete" | "test";

export interface ModelBulkResult {
  action: ModelBulkAction;
  changed?: number;
  tested?: number;
  ok?: number;
  results?: { modelId: string; model: string; ok: boolean; ttftMs: number | null; error: string | null }[];
  /** the refreshed list, so the table never shows a stale selection */
  models: NodeModel[];
}

/* ── config: settings + client api keys ────────────────────────────────────── */
export interface Settings {
  /** gate: when false the proxy accepts requests without a client key */
  requireApiKey?: boolean;
  /** RTK token-saver compression */
  rtkEnabled?: boolean;
  /** how much the gateway records: debug | info | warn | error (live, survives restart) */
  logLevel?: string;
  /** daily ceiling on metered upstream spend; 0 or absent = unlimited */
  budgetUsdPerDay?: number;
  [k: string]: unknown;
}

/** Per-node upstream price, used for cost tracking and the budget ceiling.
 *  A node without this is unmetered: it records no cost and is never blocked. */
export interface NodePricing {
  inputPer1M?: number;
  outputPer1M?: number;
}

/** Node-level tuning knobs carried in the node's `data` blob. */
export interface NodeData {
  /** null explicitly clears a price (the backend merges, it does not replace) */
  pricing?: NodePricing | null;
  /** stall watchdog budget in ms; 0 disables */
  streamIdleTimeoutMs?: number;
  /** upstream connection pool tuning */
  pool?: { connections?: number; keepAliveTimeoutMs?: number; pipelining?: number; noDelay?: boolean };
  [k: string]: unknown;
}

export interface ApiKey {
  id: string;
  name: string | null;
  enabled: boolean;
  /** the full key, so the dashboard can copy it again. null for keys created
   *  before the value was kept — those can only be deleted and re-created. */
  key: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** POST /api/keys — same shape as a listed key. */
export interface CreatedApiKey {
  id: string;
  key: string;
  name: string | null;
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
