// The Usage screen's date range, at its server: usageStats(repos, since) must scope every
// aggregate to the caller's window, while the no-argument path keeps its exact 7-day meaning —
// the dashboard home reads that shape, and a silent change there would move numbers nobody
// asked about. The chosen-window path must also ask for NO practical row cap (the "All"
// range's contract): aggregates over a slice would quietly under-report.
import { describe, expect, it } from "vitest";
import { usageStats } from "../http/api.mjs";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const row = (ts, over = {}) => ({
  ts,
  status: "ok",
  prompt_tokens: 10,
  completion_tokens: 5,
  cost_usd: 0.01,
  ttft_ms: 100,
  ...over,
});

/** The one call shape usageStats uses: ts >= since, newest first, capped at limit. */
const fakeRepos = (rows) => {
  const seen = { since: undefined, limit: undefined };
  return {
    seen,
    usage: {
      query: ({ since, limit }) => {
        seen.since = since;
        seen.limit = limit;
        return rows.filter((r) => r.ts >= (since ?? 0)).sort((a, b) => b.ts - a.ts).slice(0, limit);
      },
    },
  };
};

const now = Date.now();
const startOfToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const midToday = startOfToday + Math.floor((now - startOfToday) / 2);

// One row in each window band: today, 3d (inside 7d), 10d (outside 7d, inside 30d),
// 40d error (outside 30d, inside 60d) — every preset has a row only it should see.
const rows = [
  row(midToday),
  row(now - 3 * DAY),
  row(now - 10 * DAY),
  row(now - 40 * DAY, { status: "error" }),
];

describe("usageStats windows (the date-range filter's server)", () => {
  it("keeps the default exactly 7 days — the dashboard home's numbers do not move", () => {
    const repos = fakeRepos(rows);
    const s = usageStats(repos);
    expect(repos.seen.limit).toBe(100_000); // default keeps its old ceiling
    expect(s.requestsToday).toBe(1);
    expect(s.tokens7d).toBe(2 * 15); // today + 3d only
    expect(s.errorRatePct).toBe(0);
    expect(s.ttftP50Ms).toBe(100);
    expect(typeof s.costUsdToday).toBe("number");
  });

  it("scopes every aggregate to a caller-chosen since", () => {
    const repos = fakeRepos(rows);
    const s = usageStats(repos, now - 30 * DAY);
    expect(repos.seen.since).toBe(now - 30 * DAY);
    expect(s.tokens7d).toBe(3 * 15); // today + 3d + 10d — the 40d error row is outside
    expect(s.errorRatePct).toBe(0);
    expect(s.requestsToday).toBe(1);
  });

  it("since=0 is All: every row, errors included, and no practical cap", () => {
    const repos = fakeRepos(rows);
    const s = usageStats(repos, 0);
    expect(repos.seen.since).toBe(0);
    expect(repos.seen.limit).toBe(1_000_000); // "all ya all" — aggregates never slice
    expect(s.tokens7d).toBe(4 * 15);
    expect(s.errorRatePct).toBe(25); // 1 of 4
    expect(s.requestsToday).toBe(1); // still only today's row, even over the whole history
  });

  it("a 60d window sees the 40d row that 30d misses", () => {
    const s = usageStats(fakeRepos(rows), now - 60 * DAY);
    expect(s.tokens7d).toBe(4 * 15);
    expect(s.errorRatePct).toBe(25);
  });

  it("an empty window reports zeros, not NaN", () => {
    const s = usageStats(fakeRepos(rows), now); // since = now → nothing qualifies
    expect(s.tokens7d).toBe(0);
    expect(s.errorRatePct).toBe(0);
    expect(s.ttftP50Ms).toBe(0);
    expect(s.requestsToday).toBe(0);
  });
});
