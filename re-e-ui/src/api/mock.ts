/**
 * Mock transport for the preview slice. In-memory store with simulated latency;
 * swap `api` for a real fetch client against re-e-core §5 without touching screens.
 */
import type {
  GatewayInfo,
  NewNodeInput,
  RecentFailure,
  TestResult,
  UpstreamNode,
  UsageStats,
} from "./types";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

const seedNodes: UpstreamNode[] = [
  {
    id: "node_openrouter",
    name: "OpenRouter Main",
    baseUrl: "https://openrouter.ai/api/v1",
    prefix: "or/",
    status: "healthy",
    latencyMs: 42,
    modelCount: 38,
    keyMasked: "sk-or-…9f2c",
  },
  {
    id: "node_ollama",
    name: "Local Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    prefix: "local/",
    status: "degraded",
    latencyMs: 212,
    modelCount: 6,
    keyMasked: "—",
    lastError: "429 rate limited · retry after 30s",
  },
  {
    id: "node_glm",
    name: "GLM Backup",
    baseUrl: "https://api.glm.example/v1",
    prefix: "glm/",
    status: "down",
    latencyMs: null,
    modelCount: 12,
    keyMasked: "sk-glm-…aa41",
    lastError: "upstream 502 · breaker open",
  },
];

const seedStats: UsageStats = {
  requestsToday: 1284,
  tokens7d: 3_412_884,
  costUsd7d: 6.12,
  errorRatePct: 1.8,
  ttftP50Ms: 380,
};

const seedFailures: RecentFailure[] = [
  {
    id: "f1",
    at: "14:32:07",
    requestId: "req_9f2c81ab",
    nodeName: "GLM Backup",
    errorCode: "upstream_error",
    message: "502 from api.glm.example after 2 retries",
  },
  {
    id: "f2",
    at: "14:29:51",
    requestId: "req_77b1e044",
    nodeName: "Local Ollama",
    errorCode: "rate_limited",
    message: "429 · fell back to OpenRouter Main",
  },
  {
    id: "f3",
    at: "14:11:19",
    requestId: "req_0ad3c912",
    nodeName: "GLM Backup",
    errorCode: "network_error",
    message: "connect timeout after 8000ms",
  },
];

const gateway: GatewayInfo = {
  online: true,
  endpoint: "http://127.0.0.1:8787/v1",
  keyMasked: "sk-re-e-…c41d",
  version: "0.1.0",
};

const store = {
  nodes: seedNodes.map((n) => ({ ...n })),
  stats: { ...seedStats },
  failures: seedFailures.map((f) => ({ ...f })),
  seq: 0,
};

export const api = {
  async listNodes(): Promise<UpstreamNode[]> {
    await delay(120);
    return store.nodes.map((n) => ({ ...n }));
  },

  async addNode(input: NewNodeInput): Promise<UpstreamNode> {
    await delay(250);
    store.seq += 1;
    const node: UpstreamNode = {
      id: `node_${store.seq}_${Date.now().toString(36)}`,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      prefix: input.prefix.trim(),
      status: "healthy",
      latencyMs: randInt(30, 90),
      modelCount: randInt(8, 40),
      keyMasked: input.apiKey ? `${input.apiKey.slice(0, 6)}…${input.apiKey.slice(-4)}` : "—",
    };
    store.nodes.push(node);
    return { ...node };
  },

  async removeNode(id: string): Promise<void> {
    await delay(150);
    store.nodes = store.nodes.filter((n) => n.id !== id);
  },

  async resetBreaker(id: string): Promise<UpstreamNode> {
    await delay(300);
    const node = store.nodes.find((n) => n.id === id);
    if (!node) throw new Error("Node not found");
    node.status = "healthy";
    node.latencyMs = randInt(30, 120);
    delete node.lastError;
    return { ...node };
  },

  async testNode(id: string): Promise<TestResult> {
    await delay(700);
    const node = store.nodes.find((n) => n.id === id);
    if (!node) return { ok: false, error: "Node not found" };
    if (node.status === "down") {
      return { ok: false, error: "Node unreachable. Check baseUrl and network." };
    }
    return { ok: true, latencyMs: node.latencyMs ?? randInt(30, 150), modelCount: node.modelCount };
  },

  /** Contract request: POST /api/nodes/{id}/test (probe + model count) */
  async testConnection(input: { baseUrl: string }): Promise<TestResult> {
    await delay(700);
    const url = input.baseUrl.trim();
    if (!/^https?:\/\/.+/.test(url)) {
      return { ok: false, error: "Node unreachable. Check baseUrl and network." };
    }
    return { ok: true, latencyMs: randInt(28, 160), modelCount: randInt(8, 48) };
  },

  async getStats(): Promise<UsageStats> {
    await delay(100);
    return { ...store.stats };
  },

  async getFailures(): Promise<RecentFailure[]> {
    await delay(100);
    return store.failures.map((f) => ({ ...f }));
  },

  async getGateway(): Promise<GatewayInfo> {
    await delay(60);
    return { ...gateway };
  },
};
