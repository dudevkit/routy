import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import { CodexQuotaError, fetchCodexQuota, parseCodexQuota } from "../core/oauth/codexQuota.mjs";
import { createCodexQuotaTracker } from "../core/oauth/codexQuotaTracker.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { createRouter } from "../lib/router.mjs";

const upstream = {
  plan_type: "plus",
  rate_limit: { primary_window: { used_percent: 40, reset_at: 1700000000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 20, limit_window_seconds: 604800 } },
  credits: { has_credits: true, unlimited: false, balance: "12.50" },
  additional_rate_limits: [{ limit_name: "Spark", metered_feature: "spark", rate_limit: { primary_window: { used_percent: 90 } } }],
};
const snapshot = () => parseCodexQuota(upstream);
function fixture() {
  const node = { id: "n", prefix: "cx", data: { authProvider: "codex-oauth" } };
  let connection = { id: "c", nodeId: "n", name: "Codex", status: "active", credentials: { authType: "oauth", authState: "active", accessToken: "secret", lastRefreshAt: "2099-01-01T00:00:00.000Z", oauthRevision: 1, providerSpecificData: { chatgptAccountId: "acct" } } };
  return {
    repos: { nodes: { list: () => [node], get: (id) => id === node.id ? node : null }, connections: { list: () => [connection], get: (id) => id === connection?.id ? connection : null } },
    replace: (c) => { connection = c; }, get: () => connection,
  };
}

describe("Codex quota client", () => {
  it("maps usage windows, credits, and additional limits", () => {
    expect(snapshot()).toEqual({ plan: "plus", credits: { hasCredits: true, unlimited: false, balance: "12.50", resetCreditsAvailableCount: null }, windows: { primary: { usedPercent: 40, remainingPercent: 60, resetAt: "2023-11-14T22:13:20.000Z", windowMinutes: 300 }, secondary: { usedPercent: 20, remainingPercent: 80, resetAt: null, windowMinutes: 10080 } }, additionalLimits: [{ name: "Spark", meteredFeature: "spark", windows: { primary: { usedPercent: 90, remainingPercent: 10, resetAt: null, windowMinutes: null }, secondary: null } }], error: null });
  });
  it("maps optional code review quota independently", () => {
    const result = parseCodexQuota({ code_review_rate_limit: { primary_window: { used_percent: 25, reset_at: 1700000000 } } });
    expect(result.additionalLimits[0]).toMatchObject({ name: "Code Review", meteredFeature: "code_review", windows: { primary: { remainingPercent: 75 } } });
  });
  it("maps alternate usage, reset credits, review, spark and keyed limits", () => {
    const rate = { primary_window: { percent_used: 25 } };
    const result = parseCodexQuota({ rate_limit: rate, review_rate_limit: rate, spark_rate_limit: rate, rate_limits_by_limit_id: { extra: { rate_limit: rate } }, reset_credits: { available_count: 2 } });
    expect(result.windows.primary.remainingPercent).toBe(75);
    expect(result.credits.resetCreditsAvailableCount).toBe(2);
    expect(result.additionalLimits.map((item) => item.meteredFeature)).toEqual(["code_review", "spark", "extra"]);
    expect(result.additionalLimits.every((item) => item.windows.primary.usedPercent === 25)).toBe(true);
    expect(parseCodexQuota({ gpt_5_3_codex_spark_rate_limit: rate }).additionalLimits[0].windows.primary.usedPercent).toBe(25);
  });
  it("sends the account header and safely handles upstream failures", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => upstream }));
    const result = await fetchCodexQuota({ accessToken: "secret", providerSpecificData: { chatgptAccountId: "acct" } }, { fetchImpl });
    expect(result.plan).toBe("plus");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer secret", "ChatGPT-Account-Id": "acct" });
    await expect(fetchCodexQuota({ accessToken: "secret" }, { fetchImpl: async () => ({ ok: false, status: 401 }) })).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });
});

describe("Codex quota tracker", () => {
  it("deduplicates, marks expiry and retains safe stale data after failure", async () => {
    const f = fixture(); let time = 1700000000000; let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchQuota = vi.fn(async () => { await gate; return snapshot(); });
    const tracker = createCodexQuotaTracker({ repos: f.repos, now: () => time, fetchQuota });
    const a = tracker.refresh("c"); const b = tracker.refresh("c");
    release(); await Promise.all([a, b]);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    expect(tracker.accounts()[0]).toMatchObject({ stale: false, plan: "plus" });
    time += 60000;
    expect(tracker.accounts()[0].stale).toBe(true);
    fetchQuota.mockRejectedValueOnce(new Error("secret upstream error"));
    expect(await tracker.refresh("c")).toMatchObject({ stale: true, error: { code: "upstream_error" } });
    expect(JSON.stringify(tracker.accounts())).not.toContain("secret");
  });
  it("refreshes rejected credentials once, persists them and retries quota", async () => {
    const f = fixture();
    f.replace({ ...f.get(), credentials: { ...f.get().credentials, refreshToken: "refresh" } });
    f.repos.oauth = { casCredentials: (_id, change) => {
      const current = f.get();
      if (current.credentials.oauthRevision !== change.expectedRevision || current.credentials.refreshToken !== change.expectedRefreshToken) return null;
      f.replace({ ...current, credentials: change.credentials });
      return f.get();
    } };
    const tokenFetch = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 }) }));
    vi.stubGlobal("fetch", tokenFetch);
    try {
      const fetchQuota = vi.fn().mockRejectedValueOnce(new CodexQuotaError("unauthorized", "rejected", 401)).mockResolvedValueOnce(snapshot());
      const tracker = createCodexQuotaTracker({ repos: f.repos, fetchQuota });
      expect((await tracker.refresh("c")).plan).toBe("plus");
      expect(tokenFetch).toHaveBeenCalledTimes(1);
      expect(fetchQuota).toHaveBeenCalledTimes(2);
      expect(fetchQuota.mock.calls[1][0].accessToken).toBe("new-token");
      expect(f.get().credentials).toMatchObject({ accessToken: "new-token", refreshToken: "new-refresh", oauthRevision: 2 });
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not retry a forbidden quota response", async () => {
    const f = fixture();
    const fetchQuota = vi.fn().mockRejectedValue(new CodexQuotaError("forbidden", "rejected", 403));
    await expect(createCodexQuotaTracker({ repos: f.repos, fetchQuota }).refresh("c")).rejects.toMatchObject({ code: "forbidden" });
    expect(fetchQuota).toHaveBeenCalledTimes(1);
  });
  it("does not refresh credentials after an in-flight reconnect", async () => {
    const f = fixture(); let rejectQuota, started;
    const ready = new Promise((resolve) => { started = resolve; });
    const fetchQuota = vi.fn(() => new Promise((_, reject) => { rejectQuota = reject; started(); }));
    const tracker = createCodexQuotaTracker({ repos: f.repos, fetchQuota });
    const pending = tracker.refresh("c");
    await ready;
    f.replace({ ...f.get(), credentials: { ...f.get().credentials, oauthRevision: 2 } });
    tracker.invalidate("c");
    rejectQuota(new CodexQuotaError("unauthorized", "rejected", 401));
    await expect(pending).rejects.toMatchObject({ code: "stale_identity" });
    expect(fetchQuota).toHaveBeenCalledTimes(1);
  });
  it("fences reconnects, including same-account reconnects", async () => {
    const f = fixture(); let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tracker = createCodexQuotaTracker({ repos: f.repos, fetchQuota: async () => { await gate; return snapshot(); } });
    const pending = tracker.refresh("c");
    f.replace({ ...f.get(), credentials: { ...f.get().credentials, oauthRevision: 2 } });
    tracker.invalidate("c"); release();
    await expect(pending).rejects.toMatchObject({ code: "stale_identity" });
    expect(tracker.accounts()[0].plan).toBeNull();
  });
  it("rejects ineligible accounts without a network call", async () => {
    const f = fixture(); f.replace({ ...f.get(), status: "disabled" });
    const fetchQuota = vi.fn();
    const tracker = createCodexQuotaTracker({ repos: f.repos, fetchQuota });
    await expect(tracker.refresh("c")).rejects.toMatchObject({ code: "disabled" });
    expect(fetchQuota).not.toHaveBeenCalled();
  });
});

describe("unified Codex quota API", () => {
  it("lists accounts and refreshes only through guarded POST", async () => {
    const f = fixture(); const fetchQuota = vi.fn(async () => snapshot());
    const routes = buildApiRoutes(f.repos, { bootstrapToken: "tok" }, "test", { codexQuotaFetch: fetchQuota });
    const router = createRouter(routes);
    const server = http.createServer((req, res) => router(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      let response = await fetch(`${base}/api/quota`);
      let data = await response.json();
      expect(data.providers.find((p) => p.id === "codex").accounts[0]).toMatchObject({ connectionId: "c", plan: null });
      expect(fetchQuota).not.toHaveBeenCalled();
      response = await fetch(`${base}/api/quota/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: "c" }) });
      expect(response.status).toBe(400);
      response = await fetch(`${base}/api/quota/refresh`, { method: "POST", headers: { "content-type": "application/json", "x-routy-action": "1" }, body: JSON.stringify({ connectionId: "c" }) });
      expect(response.status).toBe(200);
      data = await response.json(); expect(data.plan).toBe("plus");
      response = await fetch(`${base}/api/quota`); data = await response.json();
      expect(data.providers.find((p) => p.id === "codex").accounts[0].windows.primary.remainingPercent).toBe(60);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});
