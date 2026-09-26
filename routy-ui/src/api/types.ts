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

/** Live rotation state of one key — from the same store the gateway rotates against. */
export interface ConnectionHealth {
  /** closed | cooldown | disabled */
  state: string;
  /** when a cooldown ends (ISO); null unless cooling */
  openUntil?: string | null;
  /** hard failures counted toward auto-disable */
  strikes?: number;
  lastError?: string | null;
}

/** GET/POST /api/nodes/{id}/connections — keys stay masked */
export interface NodeConnection {
  id: string;
  name: string;
  status: string | null;
  priority: number | null;
  keyMasked: string;
  lastError?: string | null;
  /** per-key proxy override; null/absent means "use the provider's proxy setting" */
  proxyPoolId?: string | null;
  /** last probe of this key alone (P6) — diagnostics, not traffic */
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestTtftMs?: number | null;
  /** live rotation state — null while the key has never misbehaved */
  health?: ConnectionHealth | null;
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
/** One exit of a pool: a single proxy URL, and the unit rotation and health work on. */
export interface ProxyPoolEntry {
  id: string;
  poolId: string;
  url: string;
  enabled: boolean;
  position: number;
  /** the address the provider saw when this exit was last checked */
  egressIp?: string | null;
  lastTestedAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestError?: string | null;
  /** live cooldown state, per provider — an exit exhausted on one upstream is fine on another */
  health?: ExitHealth[];
}

/** An exit's health for one provider: "cooling on opencode, fine elsewhere" is the fact. */
export interface ExitHealth {
  nodeId: string | null;
  node: string | null;
  state: string;
  openUntil?: string | null;
  lastError?: string | null;
  failures: number;
}

/** A pool is a FLEET: many exits, rotated across, bound to providers or keys as one. */
export interface ProxyPool {
  id: string;
  name: string;
  kind: string;
  /** `strict`: may a failed proxy fall back to a direct request? */
  config: { strict?: boolean; url?: string; urls?: (string | { url: string })[]; [k: string]: unknown };
  enabled: boolean;
  /** summary of the last check: "active" | "error" | null when never tested */
  testStatus?: string | null;
  lastTestedAt?: string | null;
  lastError?: string | null;
  entries: ProxyPoolEntry[];
  exitCount: number;
  enabledCount: number;
  /** exits currently out of rotation (rate limited or unreachable, per provider) */
  coolingCount: number;
  /** distinct addresses behind the fleet — fifty exits sharing one IP are one allowance */
  egressIpCount: number;
  /** how many keys / providers point at this pool */
  boundCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPoolInput {
  name: string;
  kind?: string;
  config?: ProxyPool["config"];
  enabled?: boolean;
  /** the paste box's text, or an array of proxy URLs */
  urls?: string | string[];
}

/** POST /api/proxy-pools/{id}/test — every exit checked through its own proxy */
export interface PoolTestResult {
  ok: boolean;
  tested: number;
  healthy: number;
  entries: EntryTestResult[];
  pool?: ProxyPool;
}

/** One exit's verdict inside a pool check. */
export interface EntryTestResult {
  entryId: string;
  url: string;
  ok: boolean;
  status?: number | null;
  elapsedMs?: number | null;
  error?: string | null;
  egressIp?: string | null;
}

/** POST /api/proxy-pool-entries/{id}/test — one exit, its address included */
export interface EntryTestOutcome {
  ok: boolean;
  status?: number | null;
  elapsedMs?: number | null;
  error?: string | null;
  testUrl?: string;
  egressIp?: string | null;
  entry?: ProxyPoolEntry;
}

/** POST /api/proxy-pools/{id}/entries — the paste lands, duplicates are skipped */
export interface AddEntriesResult {
  added: number;
  skipped: number;
  rejected: string[];
  pool: ProxyPool;
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
  /** gate: when false the dashboard needs no login from any peer */
  requireLogin?: boolean;
  /** read-only: true while the dashboard is still on the shipped default password */
  passwordIsDefault?: boolean;
  /** RTK token-saver compression */
  rtkEnabled?: boolean;
  /** per-key cooldown before a rate-limited key rejoins rotation */
  keyCooldownMs?: number;
  /** first cooldown for a proxy exit that failed or was rate-limited; Retry-After wins */
  proxyCooldownMs?: number;
  /** what a proxy health check reaches for; an IP echo answers with the exit's address */
  proxyTestUrl?: string;
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

/* ── updates ───────────────────────────────────────────────────────────────── */
/** GET /api/updates — the release the gateway last saw, and whether it is newer. */
export interface UpdateState {
  /** false when the user has opted out; no request is made in that case */
  enabled: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  notes: string | null;
  publishedAt: string | null;
  url: string | null;
  checkedAt: string | null;
  /** a version the user dismissed, so the banner stays hidden for it */
  dismissed: string | null;
  error: string | null;
  /** whether the release has the signed archive attached, i.e. is installable */
  assetsReady: boolean;
}

export interface UpdateApplyResult {
  ok: boolean;
  version?: string;
  previous?: string | null;
  restarting?: boolean;
  note?: string;
  digest?: string;
}

/* ── cli tools ─────────────────────────────────────────────────────────────── */
/** One locally installed AI CLI that routy can point at itself. */
export interface CliTool {
  id: string;
  name: string;
  note: string | null;
  installed: boolean;
  binary: string | null;
  configPath: string;
  configExists: boolean;
  format: string;
  /** points at *some* gateway; baseUrl says whether it is this one */
  connected: boolean;
  baseUrl: string | null;
  /** routy wrote it, so it can put it back */
  managed: boolean;
  /** false for a tool with no local config to point at routy (Devin) */
  writable: boolean;
}
