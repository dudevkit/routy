/** API seam types — shaped to docs/ui-ux/contract-requests.md + backend-architecture.md §5. */

export type NodeStatus = "healthy" | "degraded" | "down" | "disabled";

export interface UpstreamNode {
  id: string;
  name: string;
  baseUrl: string;
  prefix: string;
  status: NodeStatus;
  latencyMs: number | null;
  modelCount: number;
  keyMasked: string;
  lastError?: string;
}

export interface NewNodeInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  prefix: string;
}

/** Contract request: POST /api/nodes/{id}/test → { ok, latencyMs, models? } */
export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  modelCount?: number;
  error?: string;
}

export interface UsageStats {
  requestsToday: number;
  tokens7d: number;
  costUsd7d: number;
  errorRatePct: number;
  ttftP50Ms: number;
}

export type ErrorCode =
  | "auth_error"
  | "rate_limited"
  | "upstream_error"
  | "network_error"
  | "all_unavailable";

export interface RecentFailure {
  id: string;
  at: string;
  requestId: string;
  nodeName: string;
  errorCode: ErrorCode;
  message: string;
}

export interface GatewayInfo {
  online: boolean;
  endpoint: string;
  keyMasked: string;
  version: string;
}
