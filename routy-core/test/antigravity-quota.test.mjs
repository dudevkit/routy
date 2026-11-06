import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { createRouter } from "../lib/router.mjs";
import {
  parseResetTime,
  parseWeeklyQuotaSummary,
  fetchAntigravityQuota,
  AntigravityQuotaError,
} from "../core/oauth/antigravityQuota.mjs";
import {
  createAntigravityQuotaTracker,
  antigravityEligibility,
} from "../core/oauth/antigravityQuotaTracker.mjs";

describe("Antigravity Quota Parser & Client", () => {
  it("parses resetTime correctly", () => {
    expect(parseResetTime(null)).toBeNull();
    expect(parseResetTime("invalid-date")).toBeNull();
    const iso = "2026-11-06T15:00:00.000Z";
    expect(parseResetTime(iso)).toBe(iso);
  });

  it("parses retrieveUserQuotaSummary weekly and 5h session groups", () => {
    const raw = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini_weekly_bucket",
              displayName: "Weekly Limit",
              window: "weekly",
              remainingFraction: 0.85,
              resetTime: "2026-11-13T00:00:00.000Z",
            },
            {
              bucketId: "gemini_session_bucket",
              displayName: "5-Hour Window",
              window: "5h",
              remainingFraction: 0.5,
              resetTime: "2026-11-06T18:00:00.000Z",
            },
          ],
        },
        {
          displayName: "Claude & GPT Models",
          buckets: [
            {
              bucketId: "claude_weekly",
              displayName: "Weekly Quota",
              window: "weekly",
              remainingFraction: 0.25,
              resetTime: "2026-11-13T00:00:00.000Z",
            },
          ],
        },
      ],
    };

    const parsed = parseWeeklyQuotaSummary(raw);
    expect(parsed.gemini_weekly).toBeDefined();
    expect(parsed.gemini_weekly.remainingPercentage).toBe(85);
    expect(parsed.gemini_weekly.used).toBe(150);
    expect(parsed.gemini_session).toBeDefined();
    expect(parsed.gemini_session.remainingPercentage).toBe(50);
    expect(parsed.claude_gpt_weekly).toBeDefined();
    expect(parsed.claude_gpt_weekly.remainingPercentage).toBe(25);
  });

  it("fetches and parses per-model quotas and weekly summary", async () => {
    const mockFetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("loadCodeAssist")) {
        return new Response(JSON.stringify({
          cloudaicompanionProject: "test-proj-123",
          currentTier: { name: "Pro" },
          paidTier: { id: "pro-tier" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({
          models: {
            "gemini-2.5-flash": {
              displayName: "Gemini 2.5 Flash",
              quotaInfo: {
                remainingFraction: 0.9,
                resetTime: "2026-11-06T20:00:00Z",
              },
            },
            "claude-3-5-sonnet": {
              displayName: "Claude 3.5 Sonnet",
              quotaInfo: {
                remainingFraction: 0.4,
                resetTime: "2026-11-06T21:00:00Z",
              },
            },
            "internal-eval-model": {
              isInternal: true,
              quotaInfo: { remainingFraction: 1 },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("retrieveUserQuotaSummary")) {
        return new Response(JSON.stringify({
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                { window: "weekly", remainingFraction: 0.75, resetTime: "2026-11-13T00:00:00Z" },
              ],
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("Not Found", { status: 404 });
    });

    const res = await fetchAntigravityQuota(
      { accessToken: "ya29.fake", projectId: "test-proj-123" },
      { fetchImpl: mockFetch }
    );

    expect(res.provider).toBe("antigravity");
    expect(res.plan).toBe("Pro");
    expect(res.quotas["gemini-2.5-flash"]).toBeDefined();
    expect(res.quotas["gemini-2.5-flash"].remainingPercentage).toBe(90);
    expect(res.quotas["gemini-2.5-flash"].displayName).toBe("Gemini 2.5 Flash");
    expect(res.quotas["claude-3-5-sonnet"]).toBeDefined();
    expect(res.quotas["claude-3-5-sonnet"].remainingPercentage).toBe(40);
    expect(res.quotas["internal-eval-model"]).toBeUndefined();
    expect(res.quotas.gemini_weekly).toBeDefined();
  });
});

describe("Unified Quota HTTP API", () => {
  let tmp, db, repos, server, port;

  const request = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-quota-api-"));
    db = openDatabase(tmp);
    repos = createRepos(db);
    repos.settings.update({ requireApiKey: false });

    const mockAntigravityFetch = vi.fn(async () => ({
      provider: "antigravity",
      plan: "Pro",
      projectId: "proj-123",
      quotas: {
        "gemini-2.5-flash": { used: 100, total: 1000, remainingPercentage: 90, resetAt: null, displayName: "Gemini 2.5 Flash" },
      },
      rawModelCount: 1,
    }));

    const dispatch = createRouter(buildApiRoutes(repos, { port: 0 }, "0.1.43", {
      antigravityQuotaFetch: mockAntigravityFetch,
    }));

    server = http.createServer((req, res) => dispatch(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("GET /api/quota returns providers list including antigravity and workbuddy", async () => {
    const r = await request("GET", "/api/quota");
    expect(r.status).toBe(200);
    expect(r.body.providers).toBeInstanceOf(Array);
    const agProvider = r.body.providers.find((p) => p.id === "antigravity");
    const wbProvider = r.body.providers.find((p) => p.id === "codebuddy-intl");
    expect(agProvider).toBeDefined();
    expect(wbProvider).toBeDefined();
    expect(agProvider.accounts).toEqual([]);
  });

  it("POST /api/quota/refresh refreshes an antigravity connection", async () => {
    const node = repos.oauth.createNodeWithConnection({
      name: "Google AG",
      prefix: "ag",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal",
      data: { authProvider: "antigravity-oauth", chatUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal", provider: "antigravity" },
      connection: {
        name: "My Account",
        credentials: {
          authType: "oauth",
          accessToken: "ya29.test",
          refreshToken: "rt.test",
          expiresAt: Date.now() + 3600_000,
          projectId: "proj-123",
          authState: "active",
        },
      },
    });

    const conn = repos.connections.list(node.id)[0];
    expect(conn).toBeDefined();

    const r = await request("POST", "/api/quota/refresh", {
      connectionId: conn.id,
      provider: "antigravity",
    }, { "x-routy-action": "1" });

    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("antigravity");
    expect(r.body.quotas["gemini-2.5-flash"]).toBeDefined();
    expect(r.body.quotas["gemini-2.5-flash"].remainingPercentage).toBe(90);

    // Verify GET /api/quota now returns cached snapshot for this account
    const qList = await request("GET", "/api/quota");
    expect(qList.status).toBe(200);
    const agAccounts = qList.body.providers.find((p) => p.id === "antigravity").accounts;
    expect(agAccounts).toHaveLength(1);
    expect(agAccounts[0].connectionId).toBe(conn.id);
    expect(agAccounts[0].plan).toBe("Pro");
    expect(agAccounts[0].quotas["gemini-2.5-flash"]).toBeDefined();
  });
});
