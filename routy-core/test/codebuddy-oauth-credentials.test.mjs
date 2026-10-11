// CodeBuddy Intl OAuth — credential resolution, refresh single-flight, and routing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { pickConnections } from "../core/dispatch.mjs";
import { resolveOAuthCredentials, isOAuthConnection, authStateOf } from "../core/oauth/credentials.mjs";

let tmp, db, repos, node;

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function oauthCreds({ accessToken = "at-1", refreshToken = "rt-1", expiresInSec = 3600, revision = 1, authState = "active" } = {}) {
  return {
    authType: "oauth", accessToken, refreshToken,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    authState, oauthRevision: revision, providerSpecificData: {},
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-oauth-cred-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  node = repos.nodes.create({
    name: "CB", prefix: "cb", apiType: "openai",
    baseUrl: "https://www.workbuddy.ai/v2/chat/completions",
    data: { authProvider: "codebuddy-intl-oauth" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { repos.close(); db.close(); } catch { /* closed */ }
});

describe("resolveOAuthCredentials", () => {
  it("returns a live token untouched when it is not near expiry", async () => {
    const c = repos.connections.create({ nodeId: node.id, name: "a", credentials: oauthCreds({ expiresInSec: 3600 }) });
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await resolveOAuthCredentials(repos, node, c);
    expect(r.ok).toBe(true);
    expect(r.refreshed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refreshes within the lead window and bumps the revision", async () => {
    const c = repos.connections.create({ nodeId: node.id, name: "a", credentials: oauthCreds({ expiresInSec: 60, revision: 3 }) });
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { code: 0, data: { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 } })));
    const r = await resolveOAuthCredentials(repos, node, c);
    expect(r.ok).toBe(true);
    expect(r.refreshed).toBe(true);
    expect(r.connection.credentials.accessToken).toBe("at-2");
    expect(r.connection.credentials.oauthRevision).toBe(4);
  });

  it("marks reauth-required when expired with no refresh token, without an upstream call", async () => {
    const c = repos.connections.create({ nodeId: node.id, name: "a", credentials: oauthCreds({ expiresInSec: -10, refreshToken: null }) });
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await resolveOAuthCredentials(repos, node, c);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("reauth-required");
    expect(spy).not.toHaveBeenCalled();
    expect(repos.connections.get(c.id).credentials.authState).toBe("reauth-required");
  });

  it("keeps credentials and reports transient on a 5xx refresh", async () => {
    const c = repos.connections.create({ nodeId: node.id, name: "a", credentials: oauthCreds({ expiresInSec: 60 }) });
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(500, { msg: "down" })));
    const r = await resolveOAuthCredentials(repos, node, c);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("transient");
    expect(repos.connections.get(c.id).credentials.authState).toBe("active");
  });

  it("dedupes a concurrent refresh across two rows sharing one refresh token (single upstream call)", async () => {
    const shared = oauthCreds({ expiresInSec: 60, refreshToken: "shared-rt" });
    const a = repos.connections.create({ nodeId: node.id, name: "a", credentials: { ...shared } });
    const b = repos.connections.create({ nodeId: node.id, name: "b", credentials: { ...shared } });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return jsonRes(200, { code: 0, data: { accessToken: "at-shared", refreshToken: "rt-new", expiresIn: 3600 } }); }));
    const [ra, rb] = await Promise.all([
      resolveOAuthCredentials(repos, node, a),
      resolveOAuthCredentials(repos, node, b),
    ]);
    expect(calls).toBe(1);
    expect(ra.ok && rb.ok).toBe(true);
    expect(repos.connections.get(a.id).credentials.accessToken).toBe("at-shared");
    expect(repos.connections.get(b.id).credentials.accessToken).toBe("at-shared");
  });

  it("loses the CAS cleanly when the row was already refreshed by a reconnect", async () => {
    const c = repos.connections.create({ nodeId: node.id, name: "a", credentials: oauthCreds({ expiresInSec: 60, revision: 1 }) });
    // Simulate a reconnect that installed newer credentials before our write lands.
    repos.connections.update(c.id, { credentials: { ...c.credentials, accessToken: "at-reconnected", oauthRevision: 5 } });
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { code: 0, data: { accessToken: "at-stale", refreshToken: "rt-2", expiresIn: 3600 } })));
    const r = await resolveOAuthCredentials(repos, node, c);
    // The stale refresh must not overwrite the reconnect's newer token.
    expect(repos.connections.get(c.id).credentials.accessToken).toBe("at-reconnected");
    expect(r.ok).toBe(true);
  });
});

describe("pickConnections with OAuth rows", () => {
  it("excludes a reauth-required OAuth row but keeps active ones", () => {
    repos.connections.create({ nodeId: node.id, name: "ok", credentials: oauthCreds() });
    repos.connections.create({ nodeId: node.id, name: "dead", credentials: oauthCreds({ authState: "reauth-required" }) });
    const picked = pickConnections(repos, node);
    expect(picked).toHaveLength(1);
    expect(picked[0].name).toBe("ok");
  });

  it("does not repurpose connection status or breaker for auth lifecycle", () => {
    const c = repos.connections.create({ nodeId: node.id, name: "dead", credentials: oauthCreds({ authState: "reauth-required" }) });
    expect(c.status).toBe("active");
    expect(repos.connections.get(c.id).credentials.authState).toBe("reauth-required");
  });
});

describe("helpers", () => {
  it("detects OAuth rows and derives authState safely", () => {
    expect(isOAuthConnection({ credentials: { authType: "oauth" } })).toBe(true);
    expect(isOAuthConnection({ credentials: { apiKey: "k" } })).toBe(false);
    expect(authStateOf({ credentials: { authType: "oauth", accessToken: "at" } })).toBe("active");
    expect(authStateOf({ credentials: { authType: "oauth" } })).toBe("reauth-required");
  });
});
