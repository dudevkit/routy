// Antigravity quota retrieval from Google Cloud Code internal APIs.
//
// Dual-source:
// 1. fetchAvailableModels (`retrieveUserQuota` / `fetchAvailableModels`):
//    Per-model remainingFraction and resetTime (e.g. 5h rolling window for paid tiers).
// 2. retrieveUserQuotaSummary (`fetchAntigravityWeeklyQuota`):
//    Aggregated weekly and 5h session quotas across Gemini and Claude & GPT groups.

import { ANTIGRAVITY } from "./antigravity.mjs";

const FETCH_MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const QUOTA_SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const LOAD_CODE_ASSIST_URL = ANTIGRAVITY.loadCodeAssistUrl;
const USER_AGENT = ANTIGRAVITY.userAgent;
const TIMEOUT_MS = 15_000;

export class AntigravityQuotaError extends Error {
  constructor(reason, message, status = 500) {
    super(message);
    this.name = "AntigravityQuotaError";
    this.reason = reason;
    this.status = status;
  }
}

/** Parses Google resetTime string into ISO date string */
export function parseResetTime(resetTime) {
  if (!resetTime) return null;
  try {
    const d = new Date(resetTime);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

const GROUP_CONFIGS = [
  {
    pattern: /gemini/i,
    weekly: { key: "gemini_weekly", displayName: "Gemini (Weekly)" },
    session: { key: "gemini_session", displayName: "Gemini (5h)" },
  },
  {
    pattern: /claude|gpt/i,
    weekly: { key: "claude_gpt_weekly", displayName: "Claude & GPT (Weekly)" },
    session: { key: "claude_gpt_session", displayName: "Claude & GPT (5h)" },
  },
];

/** Parses retrieveUserQuotaSummary response payload */
export function parseWeeklyQuotaSummary(data) {
  if (!data || typeof data !== "object") return {};
  const groups = Array.isArray(data.groups)
    ? data.groups
    : Array.isArray(data.quotaSummary?.groups)
      ? data.quotaSummary.groups
      : null;
  if (!groups) return {};

  const result = {};

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const displayName = group.displayName || "";
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];

    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const windowType = String(bucket.window || "").toLowerCase();
      const bucketText = `${bucket.bucketId || ""} ${bucket.displayName || ""}`.toLowerCase();
      const isWeekly = windowType === "weekly" || bucketText.includes("weekly");
      const isSession =
        windowType === "5h" ||
        bucketText.includes("five hour") ||
        bucketText.includes("5h") ||
        bucketText.includes("daily") ||
        windowType === "daily";

      if (!isWeekly && !isSession) continue;
      if (bucket.disabled === true && isWeekly) continue;

      const remainingFraction = bucket.disabled === true ? 0 : Number(bucket.remainingFraction);
      if (!Number.isFinite(remainingFraction)) continue;

      for (const config of GROUP_CONFIGS) {
        if (config.pattern.test(displayName)) {
          const target = isWeekly ? config.weekly : config.session;
          if (result[target.key]) break;

          const total = 1000;
          const remaining = Math.round(total * remainingFraction);
          const used = Math.max(0, total - remaining);

          result[target.key] = {
            used,
            total,
            resetAt: parseResetTime(bucket.resetTime),
            remainingPercentage: remainingFraction * 100,
            unlimited: false,
            displayName: target.displayName,
          };
          break;
        }
      }
    }
  }

  return result;
}

/** Fetches retrieveUserQuotaSummary from Google Cloud Code */
export async function fetchWeeklyQuotaSummary(accessToken, projectId, { fetchImpl = fetch } = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetchImpl(QUOTA_SUMMARY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": "2.24.0",
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) return {};
    const data = await res.json();
    return parseWeeklyQuotaSummary(data);
  } catch {
    return {};
  }
}

/** Fetches subscription info from loadCodeAssist */
export async function fetchAntigravitySubscription(accessToken, { fetchImpl = fetch } = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetchImpl(LOAD_CODE_ASSIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        metadata: { ideType: 9, platform: 1, pluginType: 2 },
        mode: 1,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetches per-model available quota and merges with weekly summary */
export async function fetchAntigravityQuota(credentials, { fetchImpl = fetch } = {}) {
  const accessToken = credentials?.accessToken;
  if (!accessToken) {
    throw new AntigravityQuotaError("missing_token", "Access token is missing", 401);
  }

  // 1. Resolve projectId and subscription info
  let projectId = credentials.projectId || null;
  let subscriptionInfo = null;
  try {
    subscriptionInfo = await fetchAntigravitySubscription(accessToken, { fetchImpl });
    if (!projectId && subscriptionInfo?.cloudaicompanionProject) {
      projectId = subscriptionInfo.cloudaicompanionProject;
    }
  } catch {
    // best-effort
  }

  // 2. Fetch fetchAvailableModels
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(FETCH_MODELS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": "2.24.0",
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AntigravityQuotaError("network_error", `Failed to reach Antigravity quota endpoint: ${err.message}`, 502);
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401) {
    throw new AntigravityQuotaError("auth_expired", "Antigravity OAuth token expired", 401);
  }
  if (res.status === 403) {
    throw new AntigravityQuotaError("forbidden", "Antigravity quota access forbidden", 403);
  }
  if (!res.ok) {
    throw new AntigravityQuotaError("upstream_error", `Antigravity quota HTTP ${res.status}`, res.status);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    throw new AntigravityQuotaError("invalid_json", "Antigravity returned non-JSON quota data", 502);
  }

  const quotas = {};
  const paidTierId = subscriptionInfo?.paidTier?.id;
  const isFreeTier = !paidTierId || paidTierId === "free-tier";

  // Per-model quotas
  if (!isFreeTier && data.models && typeof data.models === "object") {
    for (const [modelKey, info] of Object.entries(data.models)) {
      if (!info || !info.quotaInfo || info.isInternal) continue;
      const remainingFraction = Number(info.quotaInfo.remainingFraction ?? 0);
      const remainingPercentage = remainingFraction * 100;
      const total = 1000;
      const remaining = Math.round(total * remainingFraction);
      const used = Math.max(0, total - remaining);

      quotas[modelKey] = {
        modelId: modelKey,
        displayName: info.displayName || modelKey,
        used,
        total,
        remainingPercentage,
        resetAt: parseResetTime(info.quotaInfo.resetTime),
        unlimited: false,
      };
    }
  }

  // 3. Weekly quota overlay
  const weeklyQuotas = await fetchWeeklyQuotaSummary(accessToken, projectId, { fetchImpl });
  Object.assign(quotas, weeklyQuotas);

  return {
    provider: "antigravity",
    plan: subscriptionInfo?.currentTier?.name || (isFreeTier ? "Free Tier" : "Pro"),
    projectId,
    quotas,
    rawModelCount: Object.keys(data.models || {}).length,
  };
}
