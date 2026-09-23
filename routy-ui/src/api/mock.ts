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
  BatchConnectionResult,
  BatchConnectionInput,
  CreatedApiKey,
  GatewayHealth,
  GatewayInfo,
  NewConnectionInput,
  NewNodeInput,
  KeyTestResult,
  ModelBulkAction,
  ModelBulkResult,
  ModelImportResult,
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
  UpdateApplyResult,
  UpdateState,
  UsageHistoryRow,
  UsageStats,
} from "./types";
import type { LogStreamHandlers, StreamLevel } from "./client";

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const maskKey = (k: string) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? "•••" : "—");

const freshStats: UsageStats = {
  requestsToday: 0,
  tokens7d: 0,
  costUsd7d: 0,
  costUsdToday: 0,
  errorRatePct: 0,
  ttftP50Ms: 0,
};

const state = {
  nodes: [] as (UpstreamNode & { apiKey?: string })[],
  connections: [] as (NodeConnection & { nodeId: string })[],
  models: [] as NodeModel[],
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
  /* logs — round-2 parity (no server ring to clear in mock) */
  async clearLogs(): Promise<{ ok: boolean }> {
    return { ok: true };
  },

  /* updates — the mock reports "up to date" so the preview never shows a banner */
  async getUpdates(): Promise<UpdateState> {
    return {
      enabled: true,
      current: "0.1.0",
      latest: "0.1.0",
      available: false,
      notes: null,
      publishedAt: null,
      url: null,
      checkedAt: nowIso(),
      dismissed: null,
      error: null,
      assetsReady: false,
    };
  },
  async checkUpdates(): Promise<UpdateState> {
    return this.getUpdates();
  },
  async dismissUpdate(): Promise<UpdateState> {
    return this.getUpdates();
  },
  async applyUpdate(): Promise<UpdateApplyResult> {
    throw new Error("the mock transport cannot install updates");
  },
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
      modelCount: 0,
      models: [],
      data: input.data ?? {},
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
  async updateNode(id: string, patch: Partial<NewNodeInput> & { enabled?: boolean; apiType?: string }): Promise<UpstreamNode> {
    const node = state.nodes.find((n) => n.id === id);
    if (!node) throw new Error("not_found");
    if (patch.name !== undefined) node.name = patch.name.trim();
    if (patch.baseUrl !== undefined) node.baseUrl = patch.baseUrl.trim();
    if (patch.prefix !== undefined) node.prefix = patch.prefix.trim();
    if (patch.apiKey) node.keyMasked = maskKey(patch.apiKey);
    if (patch.enabled !== undefined) node.status = patch.enabled ? "healthy" : "disabled";
    const { apiKey: _drop, ...view } = node;
    return view;
  },

  async testConnection(_input: { baseUrl: string; apiKey?: string }): Promise<TestResult> {
    return probeUnavailable();
  },

  /* models + probes — the mock is the empty-state rig: nothing probed, nothing
     imported, and a fresh provider starts with an empty model list (P6). */
  async listModels(id: string): Promise<{ node: string; models: NodeModel[]; count: number }> {
    const node = state.nodes.find((n) => n.id === id);
    const models = state.models.filter((m) => m.nodeId === id);
    return { node: node?.prefix || "", models, count: models.length };
  },

  async addModel(id: string, input: { model: string }): Promise<NodeModel> {
    const existing = state.models.find((m) => m.nodeId === id && m.model === input.model.trim());
    if (existing) {
      existing.enabled = true;
      existing.stale = false;
      return existing;
    }
    const row: NodeModel = {
      id: uuid(), nodeId: id, model: input.model.trim(), source: "manual",
      enabled: true, stale: false,
      lastTestAt: null, lastTestOk: null, lastTestTtftMs: null, lastTestError: null,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    state.models.push(row);
    return row;
  },

  async updateModel(_id: string, modelId: string, patch: { model?: string; enabled?: boolean }): Promise<NodeModel> {
    const row = state.models.find((m) => m.id === modelId);
    if (!row) throw new Error("not_found");
    if (patch.model !== undefined) row.model = patch.model.trim();
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    row.updatedAt = nowIso();
    return row;
  },

  async removeModel(_id: string, modelId: string): Promise<void> {
    state.models = state.models.filter((m) => m.id !== modelId);
  },

  async importModels(): Promise<ModelImportResult> {
    throw new Error("The mock transport has no upstream to import from — run against a live gateway.");
  },

  async bulkModels(_id: string, input: { ids: string[]; action: ModelBulkAction }): Promise<ModelBulkResult> {
    const rows = state.models.filter((m) => input.ids.includes(m.id));
    if (input.action === "delete") state.models = state.models.filter((m) => !input.ids.includes(m.id));
    else if (input.action === "hide" || input.action === "show") {
      for (const m of rows) m.enabled = input.action === "show";
    } else {
      throw new Error("The mock transport cannot probe models — run against a live gateway.");
    }
    return { action: input.action, changed: rows.length, models: state.models };
  },

  async testModel(): Promise<NodeModel & { result: ProbeResult }> {
    throw new Error("The mock transport cannot probe models — run against a live gateway.");
  },

  async testConnectionKey(): Promise<KeyTestResult> {
    throw new Error("The mock transport cannot probe keys — run against a live gateway.");
  },

  async testAllKeys(id: string): Promise<{ node: string; tested: number; ok: number; results: KeyTestResult[] }> {
    return { node: state.nodes.find((n) => n.id === id)?.prefix || "", tested: 0, ok: 0, results: [] };
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

  async batchAddConnections(id: string, input: BatchConnectionInput): Promise<BatchConnectionResult> {
    const results = input.entries.filter((e) => e.apiKey?.trim()).map((entry, i) => {
      const conn = {
        id: uuid(),
        nodeId: id,
        name: entry.name || (input.name ? `${input.name} ${i + 1}` : `batch key ${i + 1}`),
        status: "active",
        priority: 100 + i,
        keyMasked: maskKey(entry.apiKey),
        lastError: null,
      };
      state.connections.push(conn);
      const { nodeId: _n, ...view } = conn;
      return { ...view, priority: conn.priority ?? 100 + i };
    });
    return { created: results.length, connections: results.map((r) => ({ id: r.id, name: r.name, keyMasked: r.keyMasked, priority: r.priority })) };
  },
  async updateConnection(id: string, patch: { name?: string; status?: string; priority?: number }): Promise<NodeConnection> {
    const conn = state.connections.find((c) => c.id === id);
    if (!conn) throw new Error("not_found");
    if (patch.name !== undefined) conn.name = patch.name;
    if (patch.status !== undefined) conn.status = patch.status as NodeConnection["status"];
    if (patch.priority !== undefined) conn.priority = patch.priority;
    const { nodeId: _n, ...view } = conn;
    return view;
  },
  async deleteConnection(id: string): Promise<void> {
    state.connections = state.connections.filter((c) => c.id !== id);
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
  async getDetails(_limit = 50, _usageEventId?: number): Promise<RequestDetail[]> {
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
    const key = `sk-${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    state.keys.push({ id, name: name ?? null, enabled: true, key, lastUsedAt: null, createdAt: nowIso() });
    return { id, key, name: name ?? null };
  },
  async removeKey(id: string): Promise<void> {
    state.keys = state.keys.filter((k) => k.id !== id);
  },
  async setKeyEnabled(id: string, enabled: boolean): Promise<void> {
    const key = state.keys.find((k) => k.id === id);
    if (key) key.enabled = enabled;
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

/**
 * No server, no stream: hands back the empty snapshot and stays closed. `level`
 * is accepted for signature parity with the live transport.
 */
export function streamLogs(handlers: LogStreamHandlers, _level?: StreamLevel): () => void {
  handlers.onInit([]);
  return () => {};
}
