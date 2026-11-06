// Antigravity quota tracker with cache TTL and in-flight request dedup.

import { fetchAntigravityQuota, AntigravityQuotaError } from "./antigravityQuota.mjs";
import { isAntigravityOAuth } from "./antigravity.mjs";
import { authStateOf, isOAuthConnection } from "./credentials.mjs";

const FRESH_TTL_MS = 180_000; // 3 minutes

export function antigravityEligibility(node, connection) {
  if (!node || !connection) return { eligible: false, reason: "not_found" };
  if (!isAntigravityOAuth(node)) return { eligible: false, reason: "not_oauth_node" };
  if (!isOAuthConnection(connection)) return { eligible: false, reason: "not_oauth_connection" };
  if (connection.status !== "active") return { eligible: false, reason: "disabled" };
  if (authStateOf(connection) !== "active") return { eligible: false, reason: "reauth-required" };
  return { eligible: true, reason: null };
}

export function createAntigravityQuotaTracker({ repos, now = () => Date.now(), fetchQuota = null } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const doFetch = fetchQuota ?? fetchAntigravityQuota;

  function nodeOf(connection) {
    return connection ? repos.nodes.get(connection.nodeId) : null;
  }

  function accounts() {
    const out = [];
    for (const node of repos.nodes.list()) {
      if (!isAntigravityOAuth(node)) continue;
      for (const connection of repos.connections.list(node.id)) {
        if (!isOAuthConnection(connection)) continue;
        const eligibility = antigravityEligibility(node, connection);
        const cached = cache.get(connection.id);
        const fresh = cached ? now() - cached.fetchedAt < FRESH_TTL_MS : false;

        out.push({
          provider: "antigravity",
          nodeId: node.id,
          nodePrefix: node.prefix,
          connectionId: connection.id,
          accountLabel: connection.name,
          connectionStatus: connection.status,
          authState: authStateOf(connection),
          eligibility: eligibility.eligible ? null : eligibility.reason,
          fetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
          stale: cached ? !fresh : false,
          plan: cached?.snapshot?.plan ?? "Free Tier",
          projectId: cached?.snapshot?.projectId ?? connection.credentials?.projectId ?? null,
          quotas: cached?.snapshot?.quotas ?? {},
          error: cached?.snapshot?.error ?? null,
        });
      }
    }
    return out;
  }

  async function refresh(connectionId) {
    const connection = repos.connections.get(connectionId);
    const node = nodeOf(connection);
    const eligibility = antigravityEligibility(node, connection);
    if (!eligibility.eligible) {
      throw new AntigravityQuotaError(eligibility.reason, "Account is not eligible for quota refresh", 400);
    }

    const existing = inflight.get(connectionId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const snapshot = await doFetch(connection.credentials);
        cache.set(connectionId, { snapshot, fetchedAt: now() });
        return {
          ...snapshot,
          fetchedAt: new Date(now()).toISOString(),
          stale: false,
        };
      } catch (err) {
        const fallback = cache.get(connectionId);
        if (fallback) {
          fallback.snapshot.error = err.message || String(err);
          return {
            ...fallback.snapshot,
            fetchedAt: new Date(fallback.fetchedAt).toISOString(),
            stale: true,
          };
        }
        throw err;
      } finally {
        inflight.delete(connectionId);
      }
    })();

    inflight.set(connectionId, promise);
    return promise;
  }

  return { accounts, refresh };
}
