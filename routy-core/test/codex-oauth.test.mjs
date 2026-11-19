import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX, startFlow, exchangeToken, refreshTokens, credentialFromTokens } from "../core/oauth/codex.mjs";
import { resolveOAuthCredentials } from "../core/oauth/credentials.mjs";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";

const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("Codex OAuth", () => {
  it("generates independent state and S256 PKCE, with the fixed callback", () => {
    const a = startFlow(), b = startFlow();
    const url = new URL(a.verificationUrl);
    expect(a.upstreamState.state).not.toBe(b.upstreamState.state);
    expect(url.searchParams.get("state")).toBe(a.upstreamState.state);
    expect(url.searchParams.get("redirect_uri")).toBe(CODEX.redirectUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(crypto.createHash("sha256").update(a.upstreamState.verifier).digest("base64url"));
  });
  it("exchanges using the verifier and preserves refresh token when not rotated", async () => {
    const fetch = vi.fn(async () => response(200, { access_token: "access", id_token: "id-token", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetch);
    expect((await exchangeToken("code", "verifier")).idToken).toBe("id-token");
    const form = new URLSearchParams(fetch.mock.calls[0][1].body);
    expect(form.get("code_verifier")).toBe("verifier");
    expect(form.get("redirect_uri")).toBe(CODEX.redirectUri);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect((await refreshTokens("old-refresh")).refreshToken).toBe("old-refresh");
  });
  it("distinguishes invalid grant from transient failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(400, { error: "invalid_grant" })));
    await expect(refreshTokens("r")).rejects.toMatchObject({ transient: false });
    vi.stubGlobal("fetch", vi.fn(async () => response(503, {})));
    await expect(refreshTokens("r")).rejects.toMatchObject({ transient: true });
  });
  it("stores ID tokens and keeps prior metadata on partial refresh", () => {
    const before = Date.parse("2026-01-01T00:00:00Z");
    const login = credentialFromTokens({ accessToken: "a", refreshToken: "r", idToken: "id", expiresInSec: 3600, chatgptAccountId: "acct" }, { now: before });
    login.providerSpecificData.extra = "keep";
    const refreshed = credentialFromTokens({ accessToken: "b", expiresInSec: 3600 }, { now: before + 1000, previousCredentials: login, previousRevision: login.oauthRevision });
    expect(login).toMatchObject({ idToken: "id", lastRefreshAt: new Date(before).toISOString() });
    expect(refreshed).toMatchObject({ idToken: "id", refreshToken: "r", lastRefreshAt: new Date(before + 1000).toISOString(), oauthRevision: 2, providerSpecificData: { chatgptAccountId: "acct", extra: "keep" } });
  });
  it("refreshes at eight days even when the access token remains valid", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-age-"));
    const db = openDatabase(tmp), repos = createRepos(db);
    try {
      const now = Date.now();
      const node = repos.nodes.create({ name: "Codex", prefix: "cx", apiType: "openai", baseUrl: CODEX.chatUrl, data: { authProvider: "codex-oauth" } });
      const creds = credentialFromTokens({ accessToken: "old", refreshToken: "r", idToken: "id", expiresInSec: 30 * 86400 }, { now: now - 8 * 86400_000 });
      const conn = repos.connections.create({ nodeId: node.id, name: "a", credentials: creds });
      const fetch = vi.fn(async () => response(200, { access_token: "new", expires_in: 3600 }));
      vi.stubGlobal("fetch", fetch);
      const result = await resolveOAuthCredentials(repos, node, conn, { now });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.connection.credentials).toMatchObject({ accessToken: "new", idToken: "id", lastRefreshAt: new Date(now).toISOString(), oauthRevision: 2 });
    } finally { repos.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  it("refreshes concurrent accounts once while preserving account metadata", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-oauth-"));
    const db = openDatabase(tmp), repos = createRepos(db);
    try {
      const node = repos.nodes.create({ name: "Codex", prefix: "cx", apiType: "openai", baseUrl: CODEX.chatUrl, data: { authProvider: "codex-oauth" } });
      const creds = credentialFromTokens({ accessToken: "old", refreshToken: "shared", expiresInSec: 1, chatgptAccountId: "account" });
      const a = repos.connections.create({ nodeId: node.id, name: "a", credentials: creds });
      const b = repos.connections.create({ nodeId: node.id, name: "b", credentials: creds });
      const fetch = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return response(200, { access_token: "new", refresh_token: "rotated", expires_in: 3600 }); });
      vi.stubGlobal("fetch", fetch);
      const results = await Promise.all([resolveOAuthCredentials(repos, node, a), resolveOAuthCredentials(repos, node, b)]);
      expect(fetch).toHaveBeenCalledTimes(1);
      for (const result of results) {
        expect(result.ok).toBe(true);
        expect(result.connection.credentials).toMatchObject({ accessToken: "new", refreshToken: "rotated", oauthRevision: 2, providerSpecificData: { chatgptAccountId: "account" } });
      }
    } finally { repos.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  it("does not let a rejected stale refresh mark a reconnected account", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-race-"));
    const db = openDatabase(tmp), repos = createRepos(db);
    try {
      const node = repos.nodes.create({ name: "Codex", prefix: "cx", apiType: "openai", baseUrl: CODEX.chatUrl, data: { authProvider: "codex-oauth" } });
      const old = credentialFromTokens({ accessToken: "old", refreshToken: "old-refresh", expiresInSec: 1 });
      const conn = repos.connections.create({ nodeId: node.id, name: "account", credentials: old });
      vi.stubGlobal("fetch", vi.fn(async () => {
        repos.connections.update(conn.id, { credentials: { ...old, accessToken: "reconnected", refreshToken: "new-refresh", oauthRevision: 2 } });
        return response(400, { error: "invalid_grant" });
      }));
      await resolveOAuthCredentials(repos, node, conn);
      expect(repos.connections.get(conn.id).credentials).toMatchObject({ accessToken: "reconnected", authState: "active", oauthRevision: 2 });
    } finally { repos.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
