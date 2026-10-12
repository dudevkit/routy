// WorkBuddy quota tracker — account assembly, process-local cache, and single-flight.
//
// The tracker is manual and read-only (see docs/workbuddy-quota-tracker-spec.md). This
// module owns the state that must NOT leak into routing: last-good snapshots, per-account
// in-flight refreshes, and the account view the dashboard reads. It never writes usage,
// budget, breakers, connection health, or test results.
//
// Two rules the cache must respect:
//   1. A token rotation changes `oauthRevision` without changing the account, so the cache
//      is keyed by the connection's verified identity, not by the revision.
//   2. A reconnect can install a different account mid-flight, so every publish is fenced
//      against the identity/revision observed when the fetch started.

import { fetchWorkbuddyQuota, QuotaError } from "./workbuddyQuota.mjs";
import { authStateOf, isOAuthConnection } from "./credentials.mjs";
import { isCodeBuddyIntlOAuth } from "../executors/codebuddyIntl.mjs";

const FRESH_TTL_MS = 60_000;

/** The verified WorkBuddy identity captured at login, if any. */
export function quotaIdentityOf(connection) {
  const uid = connection?.credentials?.providerSpecificData?.quotaIdentity?.uid;
  return typeof uid === "string" && uid.length > 0 ? uid : null;
}

/** A connection is quota-eligible only if it is a marked, active, verified OAuth account. */
export function quotaEligibility(node, connection) {
  if (!node || !connection) return { eligible: false, reason: "not_found" };
  if (!isCodeBuddyIntlOAuth(node)) return { eligible: false, reason: "not_oauth_node" };
  if (!isOAuthConnection(connection)) return { eligible: false, reason: "not_oauth_connection" };
  if (connection.status !== "active") return { eligible: false, reason: "disabled" };
  if (authStateOf(connection) !== "active") return { eligible: false, reason: "reauth-required" };
  if (!quotaIdentityOf(connection)) return { eligible: false, reason: "identity_unavailable" };
  return { eligible: true, reason: null };
}

export function createQuotaTracker({ repos, now = () => Date.now(), fetchQuota = null } = {}) {
  /** @type {Map<string, { snapshot: object, fetchedAt: number, identity: string }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map();
  // Production passes nothing and gets the real meter client; tests inject a stub so no
  // test can reach WorkBuddy.
  const doFetch = fetchQuota ?? fetchWorkbuddyQuota;

  function nodeOf(connection) {
    return connection ? repos.nodes.get(connection.nodeId) : null;
  }

  /** Every WorkBuddy OAuth connection, safe state only (no tokens, no uid). */
  function accounts() {
    const out = [];
    for (const node of repos.nodes.list()) {
      if (!isCodeBuddyIntlOAuth(node)) continue;
      for (const connection of repos.connections.list(node.id)) {
        if (!isOAuthConnection(connection)) continue;
        const eligibility = quotaEligibility(node, connection);
        const identity = quotaIdentityOf(connection);
        // A snapshot is only meaningful for the account it was fetched for. After a
        // reconnect the row can hold a different identity; the old data must not appear
        // under the new account at all.
        const cached = cache.get(connection.id);
        const usable = cached && cached.identity === identity ? cached : null;
        const fresh = usable ? now() - usable.fetchedAt < FRESH_TTL_MS : false;
        out.push({
          nodeId: node.id,
          nodePrefix: node.prefix,
          connectionId: connection.id,
          accountLabel: connection.name,
          connectionStatus: connection.status,
          authState: authStateOf(connection),
          quotaIdentityAvailable: identity !== null,
          eligibility: eligibility.eligible ? null : eligibility.reason,
          fetchedAt: usable ? new Date(usable.fetchedAt).toISOString() : null,
          stale: usable ? !fresh : false,
          aggregate: usable?.snapshot.aggregate ?? null,
          aggregateComplete: usable?.snapshot.aggregateComplete ?? false,
          packageInventoryComplete: usable?.snapshot.packageInventoryComplete ?? false,
          sources: usable?.snapshot.sources ?? null,
          subscriptionPackageCode: usable?.snapshot.subscriptionPackageCode ?? null,
          isPaidUser: usable?.snapshot.isPaidUser ?? null,
          resources: usable?.snapshot.resources ?? [],
          error: usable?.snapshot.error ?? null,
        });
      }
    }
    return out;
  }

  /**
   * Refresh one connection's snapshot from the provider. Ineligible accounts never call
   * upstream. Concurrent calls for the same connection join one in-flight request.
   */
  async function refresh(connectionId) {
    const connection = repos.connections.get(connectionId);
    const node = nodeOf(connection);
    const eligibility = quotaEligibility(node, connection);
    if (!eligibility.eligible) {
      const err = new QuotaError(eligibility.reason, "this account cannot be queried");
      err.reason = eligibility.reason;
      throw err;
    }

    const existing = inflight.get(connectionId);
    if (existing) return existing;

    // Capture the identity/revision at start so a mid-flight reconnect cannot be
    // overwritten by this response.
    const observedIdentity = quotaIdentityOf(connection);
    const observedRevision = Number(connection.credentials?.oauthRevision ?? 0);

    const promise = (async () => {
      try {
        const snapshot = await doFetch(connection.credentials, { now });
        // Fence: only publish if the row still holds the same account.
        const current = repos.connections.get(connectionId);
        const currentIdentity = quotaIdentityOf(current);
        const currentRevision = Number(current?.credentials?.oauthRevision ?? 0);
        if (currentIdentity !== observedIdentity || currentRevision !== observedRevision) {
          throw new QuotaError("stale_identity", "the account changed while the quota was being read");
        }
        cache.set(connectionId, { snapshot, fetchedAt: now(), identity: observedIdentity });
        return { ...snapshot, fetchedAt: new Date(cache.get(connectionId).fetchedAt).toISOString(), stale: false };
      } catch (err) {
        // Keep last-good data, marked stale, with a safe error code.
        const cached = cache.get(connectionId);
        const code = err instanceof QuotaError ? err.code : "upstream_error";
        if (cached) {
          const safe = { ...cached.snapshot, error: { code, message: "the last refresh failed — showing the last known values" } };
          cache.set(connectionId, { ...cached, snapshot: safe });
          return { ...safe, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: true };
        }
        throw err instanceof QuotaError ? err : new QuotaError(code, "the quota read failed");
      } finally {
        inflight.delete(connectionId);
      }
    })();
    inflight.set(connectionId, promise);
    return promise;
  }

  /** Drop cached data for a connection (reconnect, removal, or identity change). */
  function invalidate(connectionId) {
    cache.delete(connectionId);
  }

  return { accounts, refresh, invalidate, _cache: cache, _inflight: inflight };
}
