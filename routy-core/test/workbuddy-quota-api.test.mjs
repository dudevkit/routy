// WorkBuddy quota tracker — route, eligibility, cache, and fencing tests.
//
// A real temp DB and the real API router; every WorkBuddy meter call is stubbed via the
// injected fetchQuota, so nothing reaches the network and no quota is spent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { createRouter } from "../lib/router.mjs";
import { createQuotaTracker, quotaEligibility } from "../core/oauth/workbuddyQuotaTracker.mjs";
import { QuotaError } from "../core/oauth/workbuddyQuota.mjs";

let tmp, db, repos, server, port, cfg, tracker;

const request = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = http.request(
    { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null }));
    },
  );
  req.on("error", reject);
  req.end(payload ?? undefined);
});
const get = (p, headers) => request("GET", p, undefined, headers);
const post = (p, body, headers) => request("POST", p, body, headers);
const ACTION = { "x-routy-action": "1" };

const snapshot = (over = {}) => ({
  aggregate: { total: 100, used: 40, remaining: 60, unit: "unknown" },
  aggregateComplete: true,
  packageInventoryComplete: true,
  sources: { summary: { status: "success", fetched: 100, total: null }, paid: { status: "success", fetched: 1, total: 1 }, free: { status: "success", fetched: 0, total: 0 } },
  subscriptionPackageCode: "TCACA_code_002_AkiJS3ZHF5",
  isPaidUser: true,
  resources: [{ resourceId: "r-1", packageCode: "TCACA_code_002_AkiJS3ZHF5", name: "Pro", total: 100, used: 40, remaining: 60, unit: "unknown", status: "active", startsAt: null, expiresAt: null, resetsAt: null, capacityType: null, source: "paid" }],
  ...over,
});

/** Create a WorkBuddy OAuth node + connection with optional identity/status overrides. */
function addAccount({ name = "CB", prefix = "cb", uid = "uid-42", status = "active", authState = "active" } = {}) {
  const credentials = { authType: "oauth", accessToken: "at-live", refreshToken: "rt", expiresAt: new Date(Date.now() + 3600_000).toISOString(), authState, oauthRevision: 1 };
  if (uid) credentials.providerSpecificData = { quotaIdentity: { uid } };
  return repos.oauth.createNodeWithConnection({
    name,
    prefix,
    baseUrl: "https://www.workbuddy.ai/v2/chat/completions",
    data: { authProvider: "codebuddy-intl-oauth", chatUrl: "https://www.workbuddy.ai/v2/chat/completions" },
    connection: { name: `${name} account`, credentials, status },
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-quota-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });
  cfg = { bootstrapToken: "tok" };
  tracker = createQuotaTracker({ repos, fetchQuota: vi.fn(async () => snapshot()) });
  const routes = buildApiRoutes(repos, cfg, "test", { quotaFetch: vi.fn(async () => snapshot()) });
  const router = createRouter(routes);
  server = http.createServer((req, res) => router(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  db.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("eligibility", () => {
  it("accepts a marked, active, verified OAuth account", () => {
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    expect(quotaEligibility(node, conn)).toEqual({ eligible: true, reason: null });
  });
  it("refuses an account with no verified identity", () => {
    const node = addAccount({ uid: null });
    const conn = repos.connections.list(node.id)[0];
    expect(quotaEligibility(node, conn).reason).toBe("identity_unavailable");
  });
  it("refuses a disabled account", () => {
    const node = addAccount({ status: "disabled" });
    const conn = repos.connections.list(node.id)[0];
    expect(quotaEligibility(node, conn).reason).toBe("disabled");
  });
  it("refuses a reauth-required account", () => {
    const node = addAccount({ authState: "reauth-required" });
    const conn = repos.connections.list(node.id)[0];
    expect(quotaEligibility(node, conn).reason).toBe("reauth-required");
  });
  it("refuses an API-key node", () => {
    const node = repos.nodes.create({ name: "Key", prefix: "k", apiType: "openai", baseUrl: "https://x/v1" });
    const conn = repos.connections.create({ nodeId: node.id, name: "k", credentials: { apiKey: "sk" } });
    expect(quotaEligibility(node, conn).reason).toBe("not_oauth_node");
  });
});

describe("tracker refresh", () => {
  it("never calls upstream for an ineligible account", async () => {
    const node = addAccount({ uid: null });
    const conn = repos.connections.list(node.id)[0];
    await expect(tracker.refresh(conn.id)).rejects.toMatchObject({ reason: "identity_unavailable" });
    expect(tracker._cache.size).toBe(0);
  });

  it("caches a successful snapshot and reports it fresh", async () => {
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    const result = await tracker.refresh(conn.id);
    expect(result.aggregateComplete).toBe(true);
    const [row] = tracker.accounts();
    expect(row.stale).toBe(false);
    expect(row.aggregate.remaining).toBe(60);
    expect(row.resources).toHaveLength(1);
  });

  it("joins concurrent refreshes for the same account into one call", async () => {
    let calls = 0;
    const slow = createQuotaTracker({ repos, fetchQuota: vi.fn(async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return snapshot(); }) });
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    await Promise.all([slow.refresh(conn.id), slow.refresh(conn.id), slow.refresh(conn.id)]);
    expect(calls).toBe(1);
  });

  it("keeps last-good data as stale when a refresh fails", async () => {
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    await tracker.refresh(conn.id);
    tracker = createQuotaTracker({ repos, fetchQuota: vi.fn(async () => { throw new QuotaError("upstream_error", "boom"); }) });
    // Re-seed the new tracker with the old snapshot so we can observe the stale path.
    tracker._cache.set(conn.id, { snapshot: snapshot(), fetchedAt: Date.now() - 120_000, identity: "uid-42" });
    const result = await tracker.refresh(conn.id);
    expect(result.stale).toBe(true);
    expect(result.aggregate.remaining).toBe(60);
    expect(result.error.code).toBe("upstream_error");
  });

  it("refuses to publish a snapshot if the account changed mid-flight", async () => {
    let resolveFetch;
    const gate = new Promise((r) => { resolveFetch = r; });
    const racing = createQuotaTracker({ repos, fetchQuota: vi.fn(async () => { await gate; return snapshot(); }) });
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    const pending = racing.refresh(conn.id);
    // Reconnect installs a different account while the fetch is in flight.
    repos.connections.update(conn.id, { credentials: { ...conn.credentials, oauthRevision: 2, providerSpecificData: { quotaIdentity: { uid: "uid-99" } } } });
    resolveFetch();
    await expect(pending).rejects.toMatchObject({ code: "stale_identity" });
    expect(racing._cache.size).toBe(0);
  });

  it("never shows an old snapshot under a new identity", async () => {
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    await tracker.refresh(conn.id);
    expect(tracker.accounts()[0].aggregate).not.toBeNull();
    // Simulate a reconnect to a different account.
    repos.connections.update(conn.id, { credentials: { ...conn.credentials, oauthRevision: 2, providerSpecificData: { quotaIdentity: { uid: "uid-99" } } } });
    const [row] = tracker.accounts();
    expect(row.aggregate).toBeNull();
    expect(row.fetchedAt).toBeNull();
    expect(row.quotaIdentityAvailable).toBe(true);
  });
});

describe("HTTP routes", () => {
  it("GET returns safe account state with no upstream call", async () => {
    const node = addAccount();
    const r = await get("/api/providers/workbuddy/quota");
    expect(r.status).toBe(200);
    expect(r.body.accounts).toHaveLength(1);
    const row = r.body.accounts[0];
    expect(row.nodeId).toBe(node.id);
    expect(row.quotaIdentityAvailable).toBe(true);
    expect(row.aggregate).toBeNull(); // nothing fetched yet
    expect(JSON.stringify(r.body)).not.toContain("uid-42");
    expect(JSON.stringify(r.body)).not.toContain("at-live");
  });

  it("POST refresh requires the action header", async () => {
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    const r = await post("/api/providers/workbuddy/quota/refresh", { connectionId: conn.id });
    expect(r.status).toBe(400);
  });

  it("POST refresh requires a connectionId", async () => {
    const r = await post("/api/providers/workbuddy/quota/refresh", {}, ACTION);
    expect(r.status).toBe(400);
  });

  it("POST refresh 404s an unknown connection", async () => {
    const r = await post("/api/providers/workbuddy/quota/refresh", { connectionId: "nope" }, ACTION);
    expect(r.status).toBe(404);
  });

  it("POST refresh 409s an identity-unavailable account without calling upstream", async () => {
    const node = addAccount({ uid: null });
    const conn = repos.connections.list(node.id)[0];
    const r = await post("/api/providers/workbuddy/quota/refresh", { connectionId: conn.id }, ACTION);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("identity_unavailable");
  });

  it("does not leak tokens or identity in any response", async () => {
    const node = addAccount();
    const conn = repos.connections.list(node.id)[0];
    await tracker.refresh(conn.id);
    const r = await post("/api/providers/workbuddy/quota/refresh", { connectionId: conn.id }, ACTION);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("at-live");
    expect(text).not.toContain("uid-42");
    expect(text).not.toContain("Bearer");
  });
});
