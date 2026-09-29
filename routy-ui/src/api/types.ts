/**
 * API seam types — real shapes verified against the live gateway
 * (routy-core `http/api.mjs` + `db/repos.mjs`) and docs/backend-architecture.md §5.
 * Usage rows come back with snake_case DB column names; that is deliberate and
 * mapped at the UI boundary (see screens/Usage.tsx).
 */

/* ── nodes / upstreams ─────────────────────────────────────────────────────── */
export type NodeStatus = "healthy" | "degraded" | "down" | "disabled";

/**
 * The non-chat kinds routy serves, as the gateway's kind enum defines them (`core/media.mjs`).
 * A kind IS its endpoint: `image` is `/v1/images/generations`, `tts` is `/v1/audio/speech`.
 * Chat is not a media kind — it is what a node serves by default.
 */
export type MediaKind = "embedding" | "image" | "tts" | "webSearch" | "webFetch";

/** What the gateway reports for a kind: label + endpoint, so the UI never hardcodes paths. */
export interface MediaKindInfo {
  id: MediaKind;
  label: string;
  method: string;
  path: string;
  /** "node" = models come from the node's model rows · "voices" = model names a voice ·
   *  "none" = the provider IS the model (no model list to show) */
  modelList: "node" | "voices" | "none";
}

/** The six kinds and their endpoints — mirrors `MEDIA_KINDS` in routy-core/core/media.mjs, and
 *  it is the one place the two copies are written down together. A kind IS its endpoint: the
 *  server validates writes against its own copy, so drift here is a display bug, never a
 *  routing one. A `/api/media/kinds` endpoint would remove the duplication later. */
export const MEDIA_KIND_INFO: MediaKindInfo[] = [
  { id: "embedding", label: "Embeddings", method: "POST", path: "/v1/embeddings", modelList: "node" },
  { id: "image", label: "Text to Image", method: "POST", path: "/v1/images/generations", modelList: "node" },
  { id: "tts", label: "Text to Speech", method: "POST", path: "/v1/audio/speech", modelList: "voices" },
  { id: "webSearch", label: "Web Search", method: "POST", path: "/v1/search", modelList: "none" },
  { id: "webFetch", label: "Web Fetch", method: "POST", path: "/v1/web/fetch", modelList: "none" },
];

/**
 * The upstream URL the gateway derives when a kind has no explicit one: the node's base URL plus
 * the kind's path WITHOUT its `/v1` prefix, because the base carries it.
 *
 * Mirrors `upstreamUrl` in core/handlers/*.mjs. The client-facing path and the upstream path are
 * not the same string — concatenating them produces `…/v1/v1/images/generations`, which is what
 * the empty URL field's placeholder showed before this existed. A preview that claims "the same
 * rule the gateway applies" has to apply that rule exactly.
 */
export function derivedMediaUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/v1\//, "")}`;
}

/** `node.data.media` — what a node declares it serves, and how. Read and written whole on
 *  update: the gateway replaces this key rather than merging it, so a kind can be removed. */
export interface NodeMediaConfig {
  kinds?: MediaKind[];
  /** per-kind upstream URL; absent = the node's baseUrl + the kind's OpenAI path */
  urls?: Partial<Record<MediaKind, string>>;
  /** per-kind credential style; absent = bearer with the node's key */
  auth?: Partial<Record<MediaKind, { style: "bearer" | "token" | "x-api-key" | "key" | "query" | "none" }>>;
  /** the web kinds' per-provider mapping (`core/mediaMap.mjs`): the provider's request and
   *  response shapes. Sent whole, like the rest of this object — a partial one erases the rest. */
  map?: Partial<Record<MediaKind, Record<string, unknown>>>;
  /** the node needs no credential at all (a local endpoint) */
  noAuth?: boolean;
}

/** An entry from `/api/models/<kind>` — carries its own kind, because `/v1/models/web` serves
 *  two kinds at once and the client filters on the entry rather than the endpoint. */
export interface MediaModelEntry {
  id: string;
  object: "model";
  kind?: MediaKind;
  owned_by?: string;
}

/** One provider in the gateway's media catalogue (`core/mediaCatalog.mjs`). Every provider
 *  9Router ships is here; `supported: false` names the code path routy does not have yet, and
 *  carries no preset — an entry that looks selectable and then fails is worse than a gap. */
export interface MediaCatalogEntry {
  id: string;
  name: string;
  supported: boolean;
  why: string | null;
  /** 9Router's own selector for the code path the provider needs (tts providers) */
  format: string | null;
  /** for the providers that search by prompting a chat model */
  chatModel: string | null;
  models: string[];
  /** settings the operator must supply, e.g. Google PSE's `cx` */
  requires: string[];
  /** the node fragment applying this preset; null when unsupported */
  preset: { media: NodeMediaConfig } | null;
  /** where to get a key (9Router's own notice.apiKeyUrl) */
  keyUrl?: string | null;
  /** the provider's own words: free tier, pricing, quirks */
  notice?: string | null;
  /** whether the provider has a free tier, as 9Router flags it */
  free?: boolean | null;
}

/** What the gateway's node view resolves for display: the kinds as written, each kind's URL
 *  (null when unset) and auth style. Differs from NodeMediaConfig only in that nulls are shown
 *  rather than absent — an unset URL is a real thing the Media tab has to say out loud. */
export interface ResolvedNodeMedia {
  kinds: MediaKind[];
  urls: Partial<Record<MediaKind, string | null>>;
  auth: Partial<Record<MediaKind, string>>;
  /** the web kinds' mappings, as written — the dashboard has to be able to show what the
   *  operator configured, since for those kinds the mapping IS the provider support */
  map?: Partial<Record<MediaKind, Record<string, unknown>>>;
  /** which catalogue entry created this node (`core/mediaCatalog.mjs`); null for a hand-made one */
  provider?: string | null;
  noAuth: boolean;
}

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
  /** non-chat kinds this node serves — what the Media badges and filters read */
  mediaKinds: MediaKind[];
  /** the media config with each kind's URL and auth style resolved for display */
  media: ResolvedNodeMedia;
  /** always masked - plaintext never returns */
  keyMasked: string;
  lastError?: string;
}

/** A chat provider preset from 9Router's registry — `GET /api/providers/catalog`.
 *  Categories are 9Router's own: `freeTier` (key-required free usage) and `free` (no
 *  credentials). Kept separate from media catalogue entries: these are chat endpoints, they
 *  preset a whole node (endpoint + models), and `supported: false` names a transport routy's
 *  chat handler does not speak — no preset, no Add. */
export interface ProviderPreset {
  id: string;
  /** which registry card group: "freeTier" | "free" */
  category: string;
  name: string;
  /** FULL chat endpoint — routy posts to node.baseUrl verbatim. null for local/no-endpoint entries. */
  baseUrl: string | null;
  /** wire format routy must speak; supported entries are always "openai" */
  format: string;
  models: { id: string; name: string }[];
  /** where to get a key (the registry's notice.apiKeyUrl / website) */
  keyUrl: string | null;
  /** what the operator must still fill in (e.g. cloudflare's {accountId}) */
  requires: string[];
  supported: boolean;
  why: string | null;
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
  /** which endpoint served it: llm, embedding, image, tts, webSearch, webFetch */
  kind?: string;
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
  /** which endpoint it serves: "llm" (chat) or a media kind; absent = chat */
  kind?: string;
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
  /** which endpoint this combo serves: "llm" (chat) or a media kind. Absent = chat. */
  kind?: string;
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
  /** which endpoint may reach this model: chat unless it was added for a media kind */
  kind: MediaKind | "llm";
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
  /** non-chat kinds this node serves. REPLACED on update (not merged) — that is how a kind
   *  gets removed, which a merge could never express. */
  media?: NodeMediaConfig;
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
