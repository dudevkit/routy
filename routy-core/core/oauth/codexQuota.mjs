// Read the Codex account usage endpoint without exposing upstream error bodies.
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export class CodexQuotaError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "CodexQuotaError";
    this.code = code;
    this.status = status;
  }
}

function windowOf(value) {
  if (!value || typeof value !== "object") return null;
  const rawUsed = value.used_percent ?? value.percent_used;
  const used = typeof rawUsed === "number" && Number.isFinite(rawUsed) ? rawUsed : null;
  const seconds = typeof value.reset_at === "number" && Number.isFinite(value.reset_at) ? value.reset_at : null;
  const date = seconds === null ? null : new Date(seconds * 1000);
  return {
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, 100 - used),
    resetAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    windowMinutes: typeof value.limit_window_seconds === "number" && Number.isFinite(value.limit_window_seconds) ? value.limit_window_seconds / 60 : null,
  };
}

function windowsOf(rateLimit) {
  return { primary: windowOf(rateLimit?.primary_window), secondary: windowOf(rateLimit?.secondary_window) };
}

export function parseCodexQuota(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new CodexQuotaError("invalid_response", "Invalid Codex quota response");
  const credit = data.credits;
  const resetCredits = data.reset_credits ?? credit?.reset_credits;
  const resetCreditsAvailableCount = typeof resetCredits?.available_count === "number" && Number.isFinite(resetCredits.available_count) ? resetCredits.available_count : null;
  return {
    plan: typeof data.plan_type === "string" ? data.plan_type : null,
    credits: (credit && typeof credit === "object") || resetCreditsAvailableCount !== null ? {
      hasCredits: typeof credit?.has_credits === "boolean" ? credit.has_credits : null,
      unlimited: typeof credit?.unlimited === "boolean" ? credit.unlimited : null,
      balance: typeof credit?.balance === "string" || typeof credit?.balance === "number" ? String(credit.balance) : null,
      resetCreditsAvailableCount,
    } : null,
    windows: windowsOf(data.rate_limit),
    additionalLimits: [
      ...((data.code_review_rate_limit ?? data.review_rate_limit) ? [{ name: "Code Review", meteredFeature: "code_review", windows: windowsOf(data.code_review_rate_limit ?? data.review_rate_limit) }] : []),
      ...((data.spark_rate_limit ?? data.gpt_5_3_codex_spark_rate_limit) ? [{ name: "Spark", meteredFeature: "spark", windows: windowsOf(data.spark_rate_limit ?? data.gpt_5_3_codex_spark_rate_limit) }] : []),
      ...(data.rate_limits_by_limit_id && typeof data.rate_limits_by_limit_id === "object" && !Array.isArray(data.rate_limits_by_limit_id) ? Object.entries(data.rate_limits_by_limit_id).filter(([, value]) => value && typeof value === "object").map(([id, value]) => ({
        name: typeof value.limit_name === "string" ? value.limit_name : id,
        meteredFeature: typeof value.metered_feature === "string" ? value.metered_feature : id,
        windows: windowsOf(value.rate_limit ?? value),
      })) : []),
      ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.filter((item) => item && typeof item === "object").map((item) => ({
        name: typeof item.limit_name === "string" ? item.limit_name : null,
        meteredFeature: typeof item.metered_feature === "string" ? item.metered_feature : null,
        windows: windowsOf(item.rate_limit),
      })) : []),
    ],
    error: null,
  };
}

export async function fetchCodexQuota(credentials, { fetchImpl = fetch } = {}) {
  const headers = { Authorization: `Bearer ${credentials.accessToken}`, Accept: "application/json" };
  const accountId = credentials.providerSpecificData?.chatgptAccountId;
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  let response;
  try {
    response = await fetchImpl(USAGE_URL, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new CodexQuotaError("upstream_error", "Codex quota request failed");
  }
  if (!response.ok) throw new CodexQuotaError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "upstream_error", "Codex quota request failed", response.status === 401 || response.status === 403 ? response.status : 502);
  let data;
  try { data = await response.json(); } catch { throw new CodexQuotaError("invalid_response", "Invalid Codex quota response"); }
  return parseCodexQuota(data);
}
