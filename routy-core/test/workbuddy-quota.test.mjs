// WorkBuddy quota meter client — parser, capacity, and partial-source tests.
//
// Every provider call is stubbed via global fetch: no test reaches the network and none
// spends quota. Fixtures are synthetic responses shaped like the WorkBuddy 5.5.2 client.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  PAID_PACKAGE_CODES,
  FREE_PACKAGE_CODES,
  QuotaError,
  parseCount,
  resolveResourceCapacity,
  normalizeResource,
  sumSummaryCapacity,
  buildSlicePeriodRange,
  retryDelayMs,
  fetchWorkbuddyQuota,
} from "../core/oauth/workbuddyQuota.mjs";

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.restoreAllMocks(); });

const credentials = {
  authType: "oauth",
  accessToken: "at-live",
  refreshToken: "rt",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  providerSpecificData: { quotaIdentity: { uid: "uid-42" } },
};

/** A stub upstream covering all three meter endpoints. */
function installMeterUpstream({ summary, paid, free } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes("get-user-resource-summary")) {
      if (typeof summary === "function") return summary(opts);
      return jsonRes(200, summary ?? { code: 0, data: { Packages: [], SubscriptionPackageCode: "", IsPaidUser: false } });
    }
    if (u.includes("get-user-resource-paid-packages")) {
      if (typeof paid === "function") return paid(opts);
      return jsonRes(200, paid ?? { code: 0, data: { Accounts: [], TotalCount: 0 } });
    }
    if (u.includes("get-user-resource-free-packages")) {
      if (typeof free === "function") return free(opts);
      return jsonRes(200, free ?? { code: 0, data: { Accounts: [], TotalCount: 0 } });
    }
    return jsonRes(404, { msg: "unexpected" });
  }));
  return calls;
}

describe("package allowlists", () => {
  it("pins the WorkBuddy 5.5.2 paid and free code sets", () => {
    expect(PAID_PACKAGE_CODES).toHaveLength(9);
    expect(FREE_PACKAGE_CODES).toHaveLength(11);
    expect(PAID_PACKAGE_CODES).toContain("TCACA_code_002_AkiJS3ZHF5");
    expect(FREE_PACKAGE_CODES).toContain("TCACA_code_035_ArVxJcGDsm");
    // No overlap: free month is a free package, not a paid one.
    expect(PAID_PACKAGE_CODES.some((c) => FREE_PACKAGE_CODES.includes(c))).toBe(false);
  });
});

describe("numeric parsing", () => {
  it("accepts finite non-negative numbers and numeric strings, preserving zero", () => {
    expect(parseCount(0)).toBe(0);
    expect(parseCount(1200)).toBe(1200);
    expect(parseCount("1500")).toBe(1500);
  });
  it("rejects missing, malformed, negative, and non-finite values as null", () => {
    expect(parseCount(undefined)).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(parseCount("")).toBeNull();
    expect(parseCount("abc")).toBeNull();
    expect(parseCount(-1)).toBeNull();
    expect(parseCount(Infinity)).toBeNull();
  });
});

describe("capacity resolution", () => {
  it("prefers slice detail for CapacityType 4", () => {
    const raw = {
      CapacityType: 4,
      SlicePeriodUsageDetails: [{ SlicePeriodCapacitySizePrecise: 100, SlicePeriodCapacityRemainPrecise: 40 }],
      CycleCapacitySizePrecise: 999,
      CycleCapacityRemainPrecise: 999,
    };
    expect(resolveResourceCapacity(raw)).toEqual({ total: 100, remaining: 40, used: 60, complete: true });
  });
  it("falls back to cycle totals when a slice package ships no slice detail", () => {
    const raw = { CapacityType: 4, CycleCapacitySizePrecise: 500, CycleCapacityRemainPrecise: 300 };
    expect(resolveResourceCapacity(raw)).toEqual({ total: 500, remaining: 300, used: 200, complete: true });
  });
  it("uses a provider-reported used value when present", () => {
    const raw = { CycleCapacitySizePrecise: 500, CycleCapacityRemainPrecise: 300, CycleCapacityUsedPrecise: 190 };
    expect(resolveResourceCapacity(raw).used).toBe(190);
  });
  it("never invents zero for a missing measurement", () => {
    const raw = { CycleCapacitySizePrecise: 500 };
    expect(resolveResourceCapacity(raw)).toEqual({ total: 500, remaining: null, used: null, complete: false });
  });
});

describe("resource normalization", () => {
  it("maps a used-up package and keeps its identity fields", () => {
    const r = normalizeResource({
      ResourceId: "res-1",
      PackageCode: "TCACA_code_002_AkiJS3ZHF5",
      PackageName: "Pro Monthly",
      Status: 3,
      CycleCapacitySizePrecise: 100,
      CycleCapacityRemainPrecise: 0,
      CycleEndTime: 1_700_000_000_000,
    }, "paid");
    expect(r).toMatchObject({ resourceId: "res-1", name: "Pro Monthly", status: "used-up", total: 100, remaining: 0, used: 100, source: "paid" });
    expect(r.resetsAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it("falls back to the package code when no name is provided", () => {
    const r = normalizeResource({ PackageCode: "TCACA_code_001_PqouKr6QWV" }, "free");
    expect(r.name).toBe("TCACA_code_001_PqouKr6QWV");
    expect(r.status).toBe("unknown");
  });
});

describe("summary aggregation", () => {
  it("sums complete package capacities", () => {
    const r = sumSummaryCapacity([
      { CycleTotalCapacity: 100, CycleRemainCapacity: 40, CycleUsedCapacity: 60 },
      { CycleTotalCapacity: 50, CycleRemainCapacity: 50, CycleUsedCapacity: 0 },
    ]);
    expect(r).toEqual({ complete: true, total: 150, used: 60, remaining: 90 });
  });
  it("is incomplete if any required field is missing", () => {
    const r = sumSummaryCapacity([{ CycleTotalCapacity: 100, CycleRemainCapacity: 40 }]);
    expect(r).toEqual({ complete: false, total: null, used: null, remaining: null });
  });
  it("treats an empty package list as a complete zero", () => {
    expect(sumSummaryCapacity([])).toEqual({ complete: true, total: 0, used: 0, remaining: 0 });
  });
});

describe("slice period range", () => {
  it("spans the local day in the provider's timestamp format", () => {
    const range = buildSlicePeriodRange(new Date(2026, 9, 12, 15, 30, 5));
    expect(range.SlicePeriodStartTime).toBe("2026-10-12 00:00:00");
    expect(range.SlicePeriodEndTime).toBe("2026-10-12 23:59:59");
  });
});

describe("retry backoff", () => {
  it("is bounded by the cap and jitter band", () => {
    const low = retryDelayMs(1, () => 0);
    const high = retryDelayMs(1, () => 1);
    expect(low).toBe(700);
    expect(high).toBe(1300);
    expect(retryDelayMs(9, () => 1)).toBeLessThanOrEqual(Math.round(8000 * 1.3));
  });
});

describe("fetchWorkbuddyQuota", () => {
  it("fails closed without a verified identity", async () => {
    const noIdentity = { ...credentials, providerSpecificData: {} };
    await expect(fetchWorkbuddyQuota(noIdentity)).rejects.toBeInstanceOf(QuotaError);
    await expect(fetchWorkbuddyQuota(noIdentity)).rejects.toMatchObject({ code: "identity_unavailable" });
  });

  it("sends the fixed host, paths, identity headers, and allowlisted package codes", async () => {
    const calls = installMeterUpstream();
    await fetchWorkbuddyQuota(credentials);
    const urls = calls.map((c) => c.url);
    expect(urls.every((u) => u.startsWith("https://www.workbuddy.ai/billing/meter/"))).toBe(true);
    for (const c of calls) {
      expect(c.headers["X-User-Id"]).toBe("uid-42");
      expect(c.headers["X-Domain"]).toBe("www.workbuddy.ai");
      expect(c.headers.Authorization).toBe("Bearer at-live");
      expect(c.headers["Accept-Language"]).toBe("en");
    }
    const paidCall = calls.find((c) => c.url.includes("paid-packages"));
    const freeCall = calls.find((c) => c.url.includes("free-packages"));
    expect(paidCall.body.PackageCodes).toEqual([...PAID_PACKAGE_CODES]);
    expect(freeCall.body.PackageCodes).toEqual([...FREE_PACKAGE_CODES]);
    expect(paidCall.body.Status).toEqual([0, 3]);
    expect(freeCall.body.SlicePeriodStartTime).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
  });

  it("returns a complete aggregate plus package rows", async () => {
    installMeterUpstream({
      summary: { code: 0, data: { Packages: [{ CycleTotalCapacity: 100, CycleRemainCapacity: 40, CycleUsedCapacity: 60 }], SubscriptionPackageCode: "TCACA_code_002_AkiJS3ZHF5", IsPaidUser: true } },
      paid: { code: 0, data: { Accounts: [{ ResourceId: "res-1", PackageCode: "TCACA_code_002_AkiJS3ZHF5", PackageName: "Pro", Status: 0, CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 40 }], TotalCount: 1 } },
    });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(snap.aggregateComplete).toBe(true);
    expect(snap.packageInventoryComplete).toBe(true);
    expect(snap.aggregate).toEqual({ total: 100, used: 60, remaining: 40, unit: "unknown" });
    expect(snap.subscriptionPackageCode).toBe("TCACA_code_002_AkiJS3ZHF5");
    expect(snap.isPaidUser).toBe(true);
    expect(snap.resources).toHaveLength(1);
    expect(snap.sources.summary.status).toBe("success");
    expect(snap.sources.paid.status).toBe("success");
  });

  it("keeps a valid summary aggregate when a detail source fails", async () => {
    installMeterUpstream({
      summary: { code: 0, data: { Packages: [{ CycleTotalCapacity: 100, CycleRemainCapacity: 40, CycleUsedCapacity: 60 }] } },
      paid: () => jsonRes(500, { msg: "boom" }),
    });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(snap.aggregateComplete).toBe(true);
    expect(snap.packageInventoryComplete).toBe(false);
    expect(snap.sources.paid.status).toBe("failed");
    expect(snap.sources.paid.errorCode).toBe("upstream_error");
  });

  it("nulls the aggregate when the summary fails but details succeed", async () => {
    installMeterUpstream({
      summary: () => jsonRes(200, { code: 5000, msg: "no summary" }),
      free: { code: 0, data: { Accounts: [{ ResourceId: "f-1", PackageCode: "TCACA_code_001_PqouKr6QWV", Status: 0, CycleCapacitySizePrecise: 20, CycleCapacityRemainPrecise: 20 }], TotalCount: 1 } },
    });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(snap.aggregate).toBeNull();
    expect(snap.aggregateComplete).toBe(false);
    expect(snap.packageInventoryComplete).toBe(true);
    expect(snap.resources).toHaveLength(1);
    expect(snap.sources.summary.status).toBe("failed");
  });

  it("marks an incomplete summary aggregate instead of silently zeroing it", async () => {
    installMeterUpstream({ summary: { code: 0, data: { Packages: [{ CycleTotalCapacity: 100, CycleRemainCapacity: 40 }] } } });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(snap.aggregate).toBeNull();
    expect(snap.aggregateComplete).toBe(false);
    expect(snap.sources.summary.status).toBe("success");
  });

  it("dedupes by ResourceId with paid taking precedence", async () => {
    installMeterUpstream({
      paid: { code: 0, data: { Accounts: [{ ResourceId: "dup", PackageCode: "TCACA_code_002_AkiJS3ZHF5", Status: 0 }], TotalCount: 1 } },
      free: { code: 0, data: { Accounts: [{ ResourceId: "dup", PackageCode: "TCACA_code_001_PqouKr6QWV", Status: 0 }], TotalCount: 1 } },
    });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(snap.resources).toHaveLength(1);
    expect(snap.resources[0].source).toBe("paid");
  });

  it("retries a transient failure then succeeds", async () => {
    let summaryCalls = 0;
    installMeterUpstream({
      summary: () => {
        summaryCalls += 1;
        if (summaryCalls === 1) return jsonRes(500, { msg: "flaky" });
        return jsonRes(200, { code: 0, data: { Packages: [] } });
      },
    });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(summaryCalls).toBe(2);
    expect(snap.aggregateComplete).toBe(true);
  }, 15_000);

  it("does not retry a definitive 4xx", async () => {
    let calls = 0;
    installMeterUpstream({
      summary: () => { calls += 1; return jsonRes(403, { msg: "forbidden" }); },
    });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(calls).toBe(1);
    expect(snap.sources.summary.status).toBe("failed");
  });

  it("reports a truncated detail source and marks inventory incomplete", async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({ ResourceId: `r-${i}`, PackageCode: "TCACA_code_009_0XmEQc2xOf", Status: 0 }));
    installMeterUpstream({
      paid: (opts) => jsonRes(200, { code: 0, data: { Accounts: page, TotalCount: 5000 } }),
    });
    const snap = await fetchWorkbuddyQuota(credentials);
    expect(snap.sources.paid.status).toBe("truncated");
    expect(snap.packageInventoryComplete).toBe(false);
    expect(snap.sources.paid.fetched).toBe(2000); // 10 pages × 200
  }, 30_000);
});
