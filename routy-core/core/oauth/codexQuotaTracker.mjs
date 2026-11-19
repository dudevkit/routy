import { authStateOf, isOAuthConnection, resolveOAuthCredentials, refreshAfterAuthRejection } from "./credentials.mjs";
import { CodexQuotaError, fetchCodexQuota } from "./codexQuota.mjs";

const FRESH_TTL_MS = 60_000;
const isCodex = (node) => node?.data?.authProvider === "codex-oauth";
const identityOf = (connection) => connection?.credentials?.providerSpecificData?.chatgptAccountId ?? null;
const revisionOf = (connection) => Number(connection?.credentials?.oauthRevision ?? 0);

export function codexQuotaEligibility(node, connection) {
  if (!node || !connection) return { eligible: false, reason: "not_found" };
  if (!isCodex(node)) return { eligible: false, reason: "not_oauth_node" };
  if (!isOAuthConnection(connection)) return { eligible: false, reason: "not_oauth_connection" };
  if (connection.status !== "active") return { eligible: false, reason: "disabled" };
  if (authStateOf(connection) !== "active") return { eligible: false, reason: "reauth-required" };
  return { eligible: true, reason: null };
}

export function createCodexQuotaTracker({ repos, now = () => Date.now(), fetchQuota = null } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const generations = new Map();
  const doFetch = fetchQuota ?? fetchCodexQuota;

  function accounts() {
    const result = [];
    for (const node of repos.nodes.list()) {
      if (!isCodex(node)) continue;
      for (const connection of repos.connections.list(node.id)) {
        if (!isOAuthConnection(connection)) continue;
        const entry = cache.get(connection.id);
        const cached = entry && entry.identity === identityOf(connection) ? entry : null;
        result.push({
          provider: "codex", nodeId: node.id, nodePrefix: node.prefix,
          connectionId: connection.id, accountLabel: connection.name,
          connectionStatus: connection.status, authState: authStateOf(connection),
          eligibility: codexQuotaEligibility(node, connection).reason,
          fetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
          stale: cached ? Boolean(cached.error) || now() - cached.fetchedAt >= FRESH_TTL_MS : false,
          plan: cached?.snapshot.plan ?? null, credits: cached?.snapshot.credits ?? null,
          windows: cached?.snapshot.windows ?? { primary: null, secondary: null },
          additionalLimits: cached?.snapshot.additionalLimits ?? [], error: cached?.error ?? null,
        });
      }
    }
    return result;
  }

  function invalidate(connectionId) {
    cache.delete(connectionId);
    generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
    inflight.delete(connectionId);
  }

  async function refresh(connectionId) {
    const connection = repos.connections.get(connectionId);
    const node = connection && repos.nodes.get(connection.nodeId);
    const eligibility = codexQuotaEligibility(node, connection);
    if (!eligibility.eligible) throw new CodexQuotaError(eligibility.reason, "Account is not eligible for quota refresh", eligibility.reason === "not_found" ? 404 : 400);
    const generation = generations.get(connectionId) ?? 0;
    const identity = identityOf(connection);
    const existing = inflight.get(connectionId);
    if (existing && existing.generation === generation && existing.identity === identity && existing.revision === revisionOf(connection)) return existing.promise;
    const entry = { generation, identity, revision: revisionOf(connection), promise: null };
    let observedRevision = entry.revision;
    entry.promise = (async () => {
      try {
        const resolved = await resolveOAuthCredentials(repos, node, connection, { now: now() });
        if (!resolved.ok) throw new CodexQuotaError(resolved.reason, resolved.reason === "reauth-required" ? "Account needs to be reconnected" : "Could not refresh Codex credentials", resolved.reason === "reauth-required" ? 401 : 502);
        let active = resolved.connection;
        if ((generations.get(connectionId) ?? 0) !== generation || identityOf(active) !== identity) throw new CodexQuotaError("stale_identity", "Account changed during quota refresh", 409);
        observedRevision = revisionOf(active);
        let snapshot;
        try {
          snapshot = await doFetch(active.credentials, { now });
        } catch (err) {
          if (!(err instanceof CodexQuotaError) || err.code !== "unauthorized" || err.status !== 401) throw err;
          const beforeRefresh = repos.connections.get(connectionId);
          if ((generations.get(connectionId) ?? 0) !== generation || identityOf(beforeRefresh) !== identity || revisionOf(beforeRefresh) !== observedRevision || !codexQuotaEligibility(repos.nodes.get(beforeRefresh?.nodeId), beforeRefresh).eligible) {
            throw new CodexQuotaError("stale_identity", "Account changed during quota refresh", 409);
          }
          const refreshed = await refreshAfterAuthRejection(repos, node, active);
          if (!refreshed) throw err;
          const current = repos.connections.get(connectionId);
          if ((generations.get(connectionId) ?? 0) !== generation || identityOf(refreshed) !== identity || identityOf(current) !== identity || revisionOf(current) !== revisionOf(refreshed) || !codexQuotaEligibility(repos.nodes.get(current?.nodeId), current).eligible) {
            throw new CodexQuotaError("stale_identity", "Account changed during quota refresh", 409);
          }
          active = refreshed;
          observedRevision = revisionOf(active);
          snapshot = await doFetch(active.credentials, { now });
        }
        const current = repos.connections.get(connectionId);
        if ((generations.get(connectionId) ?? 0) !== generation || identityOf(current) !== identity || revisionOf(current) !== observedRevision || !codexQuotaEligibility(repos.nodes.get(current?.nodeId), current).eligible) {
          throw new CodexQuotaError("stale_identity", "Account changed during quota refresh", 409);
        }
        const fetchedAt = now();
        cache.set(connectionId, { snapshot, fetchedAt, identity, error: null });
        return { ...snapshot, error: null, fetchedAt: new Date(fetchedAt).toISOString(), stale: false };
      } catch (err) {
        const safe = err instanceof CodexQuotaError ? err : new CodexQuotaError("upstream_error", "Codex quota request failed");
        const current = repos.connections.get(connectionId);
        const cached = cache.get(connectionId);
        if (safe.code !== "stale_identity" && (generations.get(connectionId) ?? 0) === generation && current && identityOf(current) === identity && revisionOf(current) === observedRevision && cached?.identity === identity) {
          const error = { code: safe.code, message: "The last refresh failed; showing last known values" };
          cache.set(connectionId, { ...cached, error });
          return { ...cached.snapshot, error, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: true };
        }
        throw safe;
      } finally {
        if (inflight.get(connectionId) === entry) inflight.delete(connectionId);
      }
    })();
    inflight.set(connectionId, entry);
    return entry.promise;
  }
  return { accounts, refresh, invalidate };
}
