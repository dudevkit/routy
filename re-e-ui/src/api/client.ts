/**
 * Live transport — real fetch against re-e-core §5 (same-origin /ui/ or dev proxy).
 * Same `api` shape as mock.ts; selected in transport.ts.
 */
import type { GatewayInfo, NewNodeInput, RecentFailure, TestResult, UpstreamNode, UsageStats } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.error?.detail || body?.error?.message || detail;
    } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  async listNodes(): Promise<UpstreamNode[]> {
    return json<UpstreamNode[]>(await fetch("/api/nodes"));
  },

  async addNode(input: NewNodeInput): Promise<UpstreamNode> {
    return json<UpstreamNode>(
      await fetch("/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },

  async removeNode(id: string): Promise<void> {
    return json<void>(await fetch(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }));
  },

  async resetBreaker(id: string): Promise<UpstreamNode> {
    return json<UpstreamNode>(await fetch(`/api/nodes/${encodeURIComponent(id)}/reset`, { method: "POST" }));
  },

  async testNode(id: string): Promise<TestResult> {
    return json<TestResult>(await fetch(`/api/nodes/${encodeURIComponent(id)}/test`, { method: "POST" }));
  },

  async testConnection(input: { baseUrl: string }): Promise<TestResult> {
    return json<TestResult>(
      await fetch("/api/nodes/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },

  async getStats(): Promise<UsageStats> {
    return json<UsageStats>(await fetch("/api/usage/stats"));
  },

  async getFailures(): Promise<RecentFailure[]> {
    return json<RecentFailure[]>(await fetch("/api/usage/failures"));
  },

  async getGateway(): Promise<GatewayInfo> {
    return json<GatewayInfo>(await fetch("/api/gateway"));
  },
};
