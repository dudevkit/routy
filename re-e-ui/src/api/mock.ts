/**
 * Mock transport — VITE_API_MODE=mock fallback for standalone UI work with no
 * gateway running. Deliberately models a FRESH INSTALL: zero usage, empty lists,
 * masked/absent keys, modelCount 0 until probed. That makes it the empty-state
 * test rig, not a demo data generator (the live gateway provides populated data).
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
import type { LogStreamHandlers } from "./client";

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const maskKey = (k: string) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? "•••" : "—");

const freshStats: UsageStats = {
  requestsToday: 0,
  tokens7d: 0,
  costUsd7d: 0,
  errorRatePct: 0,
  ttftP50Ms: 0,
};

const state = {
  nodes: [] as (UpstreamNode & { apiKey?: string })[],
  connections: [] as (NodeConnection & { nodeId: string })[],
  combos: [] as Combo[],
  aliases: {} as AliasMap,
  pools: [] as ProxyPool[],
  keys: [] as ApiKey[],
  settings: { requireApiKey: false, rtkEnabled: true } as Settings,
  history: [] as UsageHistoryRow[],
  details: [] as RequestDetail[],
  failures: [] as RecentFailure[],
};

const probeUnavailable = (): TestResult => ({
  ok: false,
  latencyMs: 0,
  error: "mock transport — no upstream is reachable",
});

export const api = {
  /* nodes */
  async listNodes(): Promise<UpstreamNode[]> {
    return state.nodes.map(({ apiKey: _apiKey, ...view }) => view);
  },

  async addNode(input: NewNodeInput): Promise<UpstreamNode> {
    const node: UpstreamNode & { apiKey?: string } = {
      id: uuid(),
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      prefix: input.prefix.trim(),
      status: "healthy",
      latencyMs: null,
      modelCount: 0, // stays 0 until a probe lands, same as the real nodeView
      keyMasked: maskKey(input.apiKey),
      apiKey: input.apiKey,
    };
    state.nodes.push(node);
    if (input.apiKey) {
      state.connections.push({
        id: uuid(),
        nodeId: node.id,
        name: `${node.name} key`,
        status: "active",
        priority: null,
        keyMasked: node.keyMasked,
        lastError: null,
      });
    }
    const { apiKey: _drop, ...view } = node;
    return view;
  },

  async removeNode(id: string): Promise<void> {
    state.nodes = state.nodes.filter((n) => n.id !== id);
    state.connections = state.connections.filter((c) => c.nodeId !== id);
  },

  async resetBreaker(id: string): Promise<UpstreamNode> {
    const node = state.nodes.find((n) => n.id === id);
    if (!node) throw new Error("not_found");
    node.status = "healthy";
    delete node.lastError;
    const { apiKey: _drop, ...view } = node;
    return view;
  },

  async testNode(_id: string): Promise<TestResult> {
    return probeUnavailable();
  },

  async testConnection(_input: { baseUrl: string; apiKey?: string }): Promise<TestResult> {
    return probeUnavailable();
  },

  async listConnections(id: string): Promise<NodeConnection[]> {
    return state.connections.filter((c) => c.nodeId === id).map(({ nodeId: _n, ...c }) => c);
  },

  async addConnection(id: string, input: NewConnectionInput): Promise<NodeConnection> {
    const conn = {
      id: uuid(),
      nodeId: id,
      name: input.name || "key",
      status: "active",
      priority: null,
      keyMasked: maskKey(input.apiKey),
      lastError: null,
    };
    state.connections.push(conn);
    const { nodeId: _n, ...view } = conn;
    return view;
  },

  /* usage — fresh install is all zeros */
  async getStats(): Promise<UsageStats> {
    return { ...freshStats };
  },
  async getFailures(_limit = 20): Promise<RecentFailure[]> {
    return [...state.failures];
  },
  async getHistory(_params: { since?: number; limit?: number } = {}): Promise<UsageHistoryRow[]> {
    return [...state.history];
  },
  async getDetails(_limit = 50): Promise<RequestDetail[]> {
    return [...state.details];
  },

  /* gateway */
  async getGateway(): Promise<GatewayInfo> {
    return { online: true, endpoint: "http://127.0.0.1:8010/v1", keyMasked: "—", version: "0.1.0-mock" };
  },
  async getHealth(): Promise<GatewayHealth> {
    return { status: "ok", uptimeMs: 0 };
  },

  /* settings + keys */
  async getSettings(): Promise<Settings> {
    return { ...state.settings };
  },
  async putSettings(patch: Settings): Promise<Settings> {
    state.settings = { ...state.settings, ...patch };
    return { ...state.settings };
  },
  async listKeys(): Promise<ApiKey[]> {
    return [...state.keys];
  },
  async createKey(name?: string): Promise<CreatedApiKey> {
    const id = uuid();
    const key = `re_${crypto.randomUUID().replace(/-/g, "")}`;
    state.keys.push({ id, name: name ?? null, enabled: true, lastUsedAt: null, createdAt: nowIso() });
    return { id, key, name: name ?? null, warning: "plaintext key shown once — store it now" };
  },
  async removeKey(id: string): Promise<void> {
    state.keys = state.keys.filter((k) => k.id !== id);
  },

  /* routing */
  async listCombos(): Promise<Combo[]> {
    return [...state.combos];
  },
  async createCombo(input: ComboInput): Promise<Combo> {
    const combo: Combo = {
      id: uuid(),
      name: input.name,
      models: input.models ?? [],
      strategy: input.strategy ?? "fallback",
      stickyLimit: input.stickyLimit ?? 1,
      updatedAt: nowIso(),
    };
    state.combos.push(combo);
    return combo;
  },
  async updateCombo(id: string, patch: Partial<ComboInput>): Promise<Combo> {
    const combo = state.combos.find((c) => c.id === id);
    if (!combo) throw new Error("not_found");
    Object.assign(combo, patch, { updatedAt: nowIso() });
    return { ...combo };
  },
  async deleteCombo(id: string): Promise<void> {
    state.combos = state.combos.filter((c) => c.id !== id);
  },
  async listAliases(): Promise<AliasMap> {
    return { ...state.aliases };
  },
  async setAlias(input: { alias: string; target: string }): Promise<{ alias: string; target: string }> {
    state.aliases[input.alias] = input.target;
    return { alias: input.alias, target: input.target };
  },
  async deleteAlias(alias: string): Promise<void> {
    delete state.aliases[alias];
  },

  /* proxy pools */
  async listPools(): Promise<ProxyPool[]> {
    return [...state.pools];
  },
  async createPool(input: ProxyPoolInput): Promise<ProxyPool> {
    const pool: ProxyPool = {
      id: uuid(),
      name: input.name,
      kind: input.kind ?? "static",
      config: input.config ?? {},
      enabled: input.enabled !== false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.pools.push(pool);
    return { ...pool };
  },
  async updatePool(id: string, patch: Partial<ProxyPoolInput>): Promise<ProxyPool> {
    const pool = state.pools.find((p) => p.id === id);
    if (!pool) throw new Error("not_found");
    Object.assign(pool, patch, { updatedAt: nowIso() });
    return { ...pool };
  },
  async deletePool(id: string): Promise<void> {
    state.pools = state.pools.filter((p) => p.id !== id);
  },
  async testPool(_id: string): Promise<PoolTestResult> {
    const urls: string[] = [];
    return {
      ok: false,
      results: urls.map((url) => ({ url, ok: false, error: "mock transport — no egress" })),
    };
  },
};

/** No server, no stream: hands back the empty snapshot and stays closed. */
export function streamLogs(handlers: LogStreamHandlers): () => void {
  handlers.onInit([]);
  return () => {};
}
