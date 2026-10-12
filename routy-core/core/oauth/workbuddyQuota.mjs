// WorkBuddy billing-meter client and normalizer for the Usage → Quota tracker.
//
// Three authenticated POST endpoints on the fixed WorkBuddy origin report the account's
// provider-side allowance. Despite the HTTP method they are READS: nothing here buys
// credits, claims gifts, cancels renewals, or sends a model request. The tracker is
// deliberately manual — no caller may invoke this on a page load, timer, or background
// sweep (see docs/workbuddy-quota-tracker-spec.md §5).
//
// Everything is bounded: fixed host and paths (never client-supplied), redirects refused,
// 15 s per request, 1 MiB per body, 10 pages per detail source, and a 60 s refresh
// deadline. Failures are isolated per source so one broken call cannot erase the others,
// and no raw upstream body, token, or account id ever escapes this module.

import { CODEBUDDY_INTL } from "./codebuddyIntl.mjs";

const ORIGIN = `https://${CODEBUDDY_INTL.host}`;
const SUMMARY_PATH = "/billing/meter/get-user-resource-summary";
const PAID_PATH = "/billing/meter/get-user-resource-paid-packages";
const FREE_PATH = "/billing/meter/get-user-resource-free-packages";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PAGES = 10;
const PAGE_SIZE = 200;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;
const RETRY_JITTER = 0.3;
const REFRESH_DEADLINE_MS = 60_000;

// Fixed server-side allowlists from the WorkBuddy 5.5.2 client. Clients cannot choose
// package codes, and these lists are never widened from request input.
export const PAID_PACKAGE_CODES = Object.freeze([
  "TCACA_code_002_AkiJS3ZHF5", // proMon
  "TCACA_code_005_maRGyrHhw1", // proMonPlus
  "TCACA_code_003_FAnt7lcmRT", // proYear
  "TCACA_code_023_4xbGhMrE6q", // youth
  "TCACA_code_026_BaESVICNoi", // advanced
  "TCACA_code_027_0FCGVA6vSa", // flagship
  "TCACA_code_009_0XmEQc2xOf", // extra
  "TCACA_code_038_OhvqZtiPKr", // extra38
  "TCACA_code_036_lupO5WgNdG", // extraIntl
]);

export const FREE_PACKAGE_CODES = Object.freeze([
  "TCACA_code_001_PqouKr6QWV", // free
  "TCACA_code_008_cfWoLwvjU4", // freeMon
  "TCACA_code_035_ArVxJcGDsm", // freeMonIntl
  "TCACA_code_006_DbXS0lrypC", // gift
  "TCACA_code_039_KRcQj7wUat", // proTrialMon
  "TCACA_code_040_mi9rCYg46x", // proTrialYear
  "TCACA_code_007_nzdH5h4Nl0", // activity
  "TCACA_code_028_NtpWi0jzXs", // bonus28
  "TCACA_code_037_WxOD3MpI2o", // bonusIntl
  "TCACA_code_029_6wCGEWquYy", // bonus29
  "TCACA_code_030_BjSt89qTvr", // bonus30
]);

/** A sanitized provider failure. `code` is allowlisted; the message is generic. */
export class QuotaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "QuotaError";
    this.code = code;
  }
}

/** Read a response body up to a byte cap, then discard the rest. */
async function readBounded(res, maxBytes = MAX_BODY_BYTES) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text().catch(() => "");
    return text.slice(0, maxBytes);
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total >= maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - (total - value.length))));
        break;
      }
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** POST JSON to a fixed path; returns `{ status, ok, data }` without ever throwing. */
async function postJson(path, { headers, body = "{}", signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers,
      body,
      signal: merged,
      redirect: "error", // never forward the bearer to another origin
    });
    const text = await readBounded(res);
    return { status: res.status, ok: res.ok, data: safeJson(text) };
  } finally {
    clearTimeout(timer);
  }
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/** Backoff for attempt n (1-based): base·2^(n-1), capped, ±30% jitter. */
export function retryDelayMs(attempt, random = Math.random) {
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(1, Math.trunc(attempt) || 1) - 1), RETRY_MAX_MS);
  const factor = 1 + (random() * 2 - 1) * RETRY_JITTER;
  return Math.max(0, Math.round(base * factor));
}

/**
 * Run one source with bounded retries. Retriable = network/no-status, 408, 429, or 5xx.
 * A definitive 4xx or a malformed body fails immediately.
 */
async function withRetry(run, { signal, deadline } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (deadline && Date.now() >= deadline) throw new QuotaError("timeout", "quota refresh deadline exceeded");
    try {
      return await run();
    } catch (err) {
      last = err;
      const retriable = err?.retriable === true;
      if (!retriable || attempt >= MAX_ATTEMPTS) break;
      const wait = retryDelayMs(attempt);
      if (deadline && Date.now() + wait >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last ?? new QuotaError("upstream_error", "quota request failed");
}

function authHeaders(accessToken, uid) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-User-Id": uid,
    "X-Domain": CODEBUDDY_INTL.host,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Accept-Language": "en",
  };
}

/** Parse a provider count: finite non-negative numbers/numeric strings only. */
export function parseCount(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function formatBillingDateTime(date) {
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The provider's local current-day slice window, same convention as the desktop client. */
export function buildSlicePeriodRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 0);
  return {
    SlicePeriodStartTime: formatBillingDateTime(start),
    SlicePeriodEndTime: formatBillingDateTime(end),
  };
}

function parseTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value).toISOString() : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return new Date(Number(value)).toISOString();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Resolve a resource's capacity. Slice packages (CapacityType 4) prefer the current
 * slice detail and fall back to the cycle totals — the desktop does the same, because
 * some free-month packages ship no SlicePeriodUsageDetails at all.
 *
 * Returns `{ total, used, remaining, complete }` with `null` for any unverified value.
 */
export function resolveResourceCapacity(raw) {
  const slice = Number(raw?.CapacityType) === 4 ? raw?.SlicePeriodUsageDetails?.[0] : null;
  let total;
  let remaining;
  let used = parseCount(raw?.CycleCapacityUsedPrecise);
  if (slice) {
    total = parseCount(slice.SlicePeriodCapacitySizePrecise);
    remaining = parseCount(slice.SlicePeriodCapacityRemainPrecise);
  } else {
    total = parseCount(raw?.CycleCapacitySizePrecise);
    remaining = parseCount(raw?.CycleCapacityRemainPrecise);
  }
  if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining);
  const complete = total !== null && remaining !== null;
  return { total, used, remaining, complete };
}

/** Normalize one provider package row into the safe DTO. */
export function normalizeResource(raw, source) {
  const capacity = resolveResourceCapacity(raw);
  const status = Number(raw?.Status) === 3 ? "used-up" : Number(raw?.Status) === 0 ? "active" : "unknown";
  return {
    resourceId: String(raw?.ResourceId ?? ""),
    packageCode: String(raw?.PackageCode ?? ""),
    name: typeof raw?.PackageName === "string" && raw.PackageName ? raw.PackageName : String(raw?.PackageCode ?? "package"),
    total: capacity.total,
    used: capacity.used,
    remaining: capacity.remaining,
    unit: "unknown",
    status,
    startsAt: parseTime(raw?.DeductionStartTime) ?? parseTime(raw?.CycleStartTime),
    expiresAt: parseTime(raw?.DeductionEndTime) ?? parseTime(raw?.ExpiredTime) ?? parseTime(raw?.CycleEndTime),
    resetsAt: parseTime(raw?.CycleEndTime),
    capacityType: Number.isFinite(Number(raw?.CapacityType)) ? Number(raw.CapacityType) : null,
    source,
  };
}

/**
 * Sum the summary's per-package cycle capacities. The summary is the aggregate authority;
 * if ANY required value is missing/invalid the aggregate is incomplete rather than a
 * silently-zero total.
 */
export function sumSummaryCapacity(packages) {
  let total = 0;
  let used = 0;
  let remaining = 0;
  for (const p of packages) {
    const t = parseCount(p?.CycleTotalCapacity);
    const u = parseCount(p?.CycleUsedCapacity);
    const r = parseCount(p?.CycleRemainCapacity);
    if (t === null || u === null || r === null) return { complete: false, total: null, used: null, remaining: null };
    total += t;
    used += u;
    remaining += r;
  }
  return { complete: true, total, used, remaining };
}

async function fetchSummary(headers, { signal, deadline }) {
  return withRetry(async () => {
    const res = await postJson(SUMMARY_PATH, { headers, body: "{}", signal });
    if (!res.ok) {
      const err = new QuotaError("upstream_error", `summary rejected (HTTP ${res.status})`);
      err.retriable = isRetriableStatus(res.status);
      throw err;
    }
    if (!res.data || res.data.code !== 0 || !Array.isArray(res.data.data?.Packages)) {
      throw new QuotaError("upstream_bad_response", "summary returned no package data");
    }
    const packages = res.data.data.Packages;
    const totals = sumSummaryCapacity(packages);
    return {
      totals,
      subscriptionPackageCode: typeof res.data.data.SubscriptionPackageCode === "string" ? res.data.data.SubscriptionPackageCode : null,
      isPaidUser: typeof res.data.data.IsPaidUser === "boolean" ? res.data.data.IsPaidUser : null,
    };
  }, { signal, deadline });
}

/** Fetch every page for one detail source, capped and truncation-aware. */
async function fetchDetailPages(path, packageCodes, extraParams, headers, { signal, deadline }) {
  const collected = [];
  let reportedTotal = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (deadline && Date.now() >= deadline) throw new QuotaError("timeout", "quota refresh deadline exceeded");
    const body = JSON.stringify({
      PageNumber: page,
      PageSize: PAGE_SIZE,
      PackageCodes: packageCodes,
      Status: [0, 3],
      ...extraParams,
    });
    const res = await withRetry(async () => {
      const r = await postJson(path, { headers, body, signal });
      if (!r.ok) {
        const err = new QuotaError("upstream_error", `detail source rejected (HTTP ${r.status})`);
        err.retriable = isRetriableStatus(r.status);
        throw err;
      }
      if (!r.data || r.data.code !== 0 || !Array.isArray(r.data.data?.Accounts)) {
        throw new QuotaError("upstream_bad_response", "detail source returned no accounts array");
      }
      const totalCount = Number(r.data.data?.TotalCount);
      return {
        accounts: r.data.data.Accounts,
        totalCount: Number.isFinite(totalCount) && totalCount >= 0 ? totalCount : null,
      };
    }, { signal, deadline });
    collected.push(...res.accounts);
    if (res.totalCount !== null) reportedTotal = res.totalCount;
    if (res.accounts.length < PAGE_SIZE) break;
    if (res.totalCount !== null && collected.length >= res.totalCount) break;
  }
  const truncated = reportedTotal > collected.length;
  return { accounts: collected, reportedTotal, truncated };
}

/**
 * Fetch the full WorkBuddy allowance snapshot for one account.
 *
 * `credentials` must carry a live `accessToken` and the verified `providerSpecificData.quotaIdentity.uid`.
 * Returns a normalized snapshot plus per-source status; it never throws for a single source
 * failure (only for a missing identity, which callers must treat as fail-closed).
 */
export async function fetchWorkbuddyQuota(credentials, { signal, now = () => Date.now() } = {}) {
  const accessToken = credentials?.accessToken;
  const uid = credentials?.providerSpecificData?.quotaIdentity?.uid;
  if (typeof accessToken !== "string" || !accessToken) throw new QuotaError("no_credentials", "this account has no access token");
  if (typeof uid !== "string" || !uid) throw new QuotaError("identity_unavailable", "this account has no verified WorkBuddy identity — reconnect it");

  const headers = authHeaders(accessToken, uid);
  const deadline = now() + REFRESH_DEADLINE_MS;
  const sliceRange = buildSlicePeriodRange(new Date(now()));

  const [summarySettled, paidSettled, freeSettled] = await Promise.allSettled([
    fetchSummary(headers, { signal, deadline }),
    fetchDetailPages(PAID_PATH, PAID_PACKAGE_CODES, { NeedRenewInfo: true }, headers, { signal, deadline }),
    fetchDetailPages(FREE_PATH, FREE_PACKAGE_CODES, sliceRange, headers, { signal, deadline }),
  ]);

  const sources = {
    summary: { status: "not-fetched", fetched: null, total: null },
    paid: { status: "not-fetched", fetched: null, total: null },
    free: { status: "not-fetched", fetched: null, total: null },
  };

  let summary = null;
  if (summarySettled.status === "fulfilled") {
    summary = summarySettled.value;
    sources.summary = { status: "success", fetched: summary.totals.complete ? summary.totals.total : null, total: null };
  } else {
    sources.summary = { status: "failed", fetched: null, total: null, errorCode: summarySettled.reason?.code || "upstream_error" };
  }

  const resources = [];
  const seen = new Set();
  let inventoryComplete = true;
  for (const [key, settled] of [["paid", paidSettled], ["free", freeSettled]]) {
    if (settled.status !== "fulfilled") {
      sources[key] = { status: "failed", fetched: null, total: null, errorCode: settled.reason?.code || "upstream_error" };
      inventoryComplete = false;
      continue;
    }
    const { accounts, reportedTotal, truncated } = settled.value;
    sources[key] = { status: truncated ? "truncated" : "success", fetched: accounts.length, total: reportedTotal || accounts.length };
    if (truncated) inventoryComplete = false;
    for (const raw of accounts) {
      const resource = normalizeResource(raw, key);
      // Dedupe only by a real provider id; paid wins when the same id appears twice.
      if (resource.resourceId) {
        if (seen.has(resource.resourceId)) continue;
        seen.add(resource.resourceId);
      }
      resources.push(resource);
    }
  }

  const aggregateComplete = summary?.totals.complete === true;
  const aggregate = aggregateComplete
    ? { total: summary.totals.total, used: summary.totals.used, remaining: summary.totals.remaining, unit: "unknown" }
    : null;

  return {
    aggregate,
    aggregateComplete,
    packageInventoryComplete: inventoryComplete,
    sources,
    subscriptionPackageCode: summary?.subscriptionPackageCode ?? null,
    isPaidUser: summary?.isPaidUser ?? null,
    resources,
  };
}
