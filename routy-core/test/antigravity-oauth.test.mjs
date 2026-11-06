import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import {
  ANTIGRAVITY,
  ANTIGRAVITY_MODELS,
  buildAuthUrl,
  startFlow,
  normalizeTokens,
  credentialFromTokens,
  refreshTokens,
  isAntigravityOAuth,
  antigravityMarker,
} from "../core/oauth/antigravity.mjs";
import {
  AntigravityExecutor,
  rewriteAntigravityPromptText,
} from "../core/executors/antigravity.mjs";
import { resolveOAuthCredentials } from "../core/oauth/credentials.mjs";

describe("Antigravity OAuth unit tests", () => {
  it("builds correct Google OAuth authorization URL", () => {
    const urlStr = buildAuthUrl("http://localhost:8010/callback", "test-state-123");
    const u = new URL(urlStr);
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.pathname).toBe("/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(ANTIGRAVITY.clientId);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:8010/callback");
    expect(u.searchParams.get("state")).toBe("test-state-123");
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
  });

  it("starts a flow with state and verification URL", () => {
    const flow = startFlow({ redirectUri: "http://localhost:8010/callback" });
    expect(flow.upstreamState).toBeTruthy();
    expect(flow.verificationUrl).toContain("accounts.google.com");
    expect(flow.verificationUrl).toContain(encodeURIComponent("http://localhost:8010/callback"));
    expect(flow.expiresAt).toBeGreaterThan(Date.now());
  });

  it("normalizes Google token responses and creates credentials", () => {
    const raw = {
      access_token: "ya29.test_access_token",
      refresh_token: "1//test_refresh_token",
      expires_in: 3599,
      token_type: "Bearer",
    };
    const norm = normalizeTokens(raw, null, {
      email: "dev@example.com",
      projectId: "project-123",
      tierId: "standard-tier",
    });
    expect(norm.accessToken).toBe("ya29.test_access_token");
    expect(norm.refreshToken).toBe("1//test_refresh_token");
    expect(norm.expiresInSec).toBe(3599);
    expect(norm.email).toBe("dev@example.com");
    expect(norm.projectId).toBe("project-123");

    const creds = credentialFromTokens(norm, { now: 1000000 });
    expect(creds.authType).toBe("oauth");
    expect(creds.accessToken).toBe("ya29.test_access_token");
    expect(creds.refreshToken).toBe("1//test_refresh_token");
    expect(creds.email).toBe("dev@example.com");
    expect(creds.projectId).toBe("project-123");
    expect(creds.tierId).toBe("standard-tier");
    expect(creds.oauthRevision).toBe(1);
    expect(creds.authState).toBe("active");
  });

  it("recognizes Antigravity OAuth markers and nodes", () => {
    expect(antigravityMarker()).toBe("antigravity-oauth");
    expect(isAntigravityOAuth({ data: { authProvider: "antigravity-oauth" } })).toBe(true);
    expect(isAntigravityOAuth({ data: { provider: "antigravity" } })).toBe(true);
    expect(isAntigravityOAuth({ data: { preset: "antigravity" } })).toBe(true);
    expect(isAntigravityOAuth({ data: { authProvider: "codebuddy-intl-oauth" } })).toBe(false);
  });
});

describe("Antigravity Executor & Prompt Rewrites", () => {
  it("builds correct daily CloudCode URLs for streaming and non-streaming", () => {
    const ex = new AntigravityExecutor(
      { prefix: "ag", baseUrl: "x", data: { authProvider: "antigravity-oauth" } },
      { credentials: { authType: "oauth", accessToken: "test-token" } }
    );
    expect(ex.buildUrl("gemini-3.8-flash-high", true)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(ex.buildUrl("gemini-3.8-flash-high", false)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(ex.buildUrl("gemini-3.1-flash-image", true)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent"); // image gen forces non-stream
  });

  it("sets correct User-Agent and Authorization headers", () => {
    const ex = new AntigravityExecutor(
      { prefix: "ag", baseUrl: "x", data: { authProvider: "antigravity-oauth" } },
      { credentials: { authType: "oauth", accessToken: "ya29.live_token" } }
    );
    const headers = ex.buildHeaders();
    expect(headers.authorization).toBe("Bearer ya29.live_token");
    expect(headers["User-Agent"]).toBe("antigravity/hub/2.24.0 darwin/arm64");
    expect(ex.rateLimitIsPerAddress()).toBe(false);
  });

  it("rewrites competing-agent brandings to avoid fake 429 RESOURCE_EXHAUSTED", () => {
    const claudePrompt = "You are a Claude agent, built on Anthropic's Claude Agent SDK. Do work.";
    expect(rewriteAntigravityPromptText(claudePrompt)).toBe(" Do work.");

    const hermesPrompt = "You are Hermes, an intelligent AI assistant built by Nous Research.";
    expect(rewriteAntigravityPromptText(hermesPrompt)).toBe("You are an AI assistant.");

    const billingHeader = "x-anthropic-billing-header: test-val\nHello";
    expect(rewriteAntigravityPromptText(billingHeader)).toBe("Hello");
  });
});

describe("Antigravity OAuth in End-to-End Chat Handler", () => {
  let tmp, db, repos, handlerServer, handlerPort, stubServer, stubPort, stubCalls;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-ag-test-"));
    db = openDatabase(tmp);
    repos = createRepos(db);
    stubCalls = [];

    stubServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        stubCalls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"candidates":[{"content":{"parts":[{"text":"Hello from Antigravity!"}],"role":"model"},"finishReason":"STOP"}]}\n\n');
        res.end();
      });
    });
    stubPort = await new Promise((r) => stubServer.listen(0, "127.0.0.1", () => r(stubServer.address().port)));
    repos.settings.update({ requireApiKey: false });
    const handler = createChatHandler(repos);
    handlerServer = http.createServer((req, res) => handler(req, res));
    handlerPort = await new Promise((r) => handlerServer.listen(0, "127.0.0.1", () => r(handlerServer.address().port)));
  });
  afterEach(async () => {
    try { repos.close(); db.close(); } catch {}
    handlerServer?.closeAllConnections?.();
    stubServer?.closeAllConnections?.();
    await new Promise((r) => handlerServer?.close(r));
    await new Promise((r) => stubServer?.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("routes Antigravity requests through AntigravityExecutor with Gemini envelope", async () => {
    const node = repos.oauth.createNodeWithConnection({
      name: "Google Antigravity",
      prefix: "ag",
      baseUrl: `http://127.0.0.1:${stubPort}`,
      data: { authProvider: "antigravity-oauth", provider: "antigravity", preset: "antigravity" },
      connection: {
        name: "Main Google Account",
        credentials: {
          authType: "oauth",
          accessToken: "ya29.stub_token",
          projectId: "cloudaicompanion-test-project",
          authState: "active",
        },
      },
    });

    const payload = JSON.stringify({
      model: "ag/gemini-3.8-flash-high",
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    });

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: handlerPort,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode, body: b }));
      });
      req.on("error", reject);
      req.end(payload);
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("Hello from Antigravity!");
    expect(stubCalls).toHaveLength(1);
    const call = stubCalls[0];
    expect(call.headers.authorization).toBe("Bearer ya29.stub_token");
    expect(call.headers["user-agent"]).toBe("antigravity/hub/2.24.0 darwin/arm64");
    // CloudCode request envelope
    expect(call.body.project).toBe("cloudaicompanion-test-project");
    expect(call.body.userAgent).toBe("antigravity");
    expect(call.body.requestId).toMatch(/^agent[-/]/);
    expect(call.body.request.contents).toBeDefined();
    expect(call.body.request.contents[0].parts[0].text).toBe("Hi");
  });
});
describe("Antigravity OAuth API Routes", () => {
  let tmpApi, dbApi, reposApi, serverApi, portApi;

  beforeEach(async () => {
    tmpApi = fs.mkdtempSync(path.join(os.tmpdir(), "routy-ag-api-"));
    dbApi = openDatabase(tmpApi);
    reposApi = createRepos(dbApi);
    reposApi.settings.update({ requireApiKey: false });
    const { buildApiRoutes } = await import("../http/api.mjs");
    const { createRouter } = await import("../lib/router.mjs");
    const dispatch = createRouter(buildApiRoutes(reposApi, { bootstrapToken: "tok" }, "0.1.0"));
    serverApi = http.createServer((req, res) => dispatch(req, res));
    portApi = await new Promise((r) => serverApi.listen(0, "127.0.0.1", () => r(serverApi.address().port)));
  });

  afterEach(async () => {
    serverApi?.closeAllConnections?.();
    await new Promise((r) => serverApi?.close(r));
    try { reposApi.close(); dbApi.close(); } catch {}
    fs.rmSync(tmpApi, { recursive: true, force: true });
  });

  const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port: portApi, path: p, method,
      headers: { "content-type": "application/json", ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d ? (() => { try { return JSON.parse(d); } catch { return d; } })() : null }));
    });
    r.on("error", reject);
    r.end(payload ?? undefined);
  });

  it("lists Antigravity among supported OAuth providers", async () => {
    const r = await req("GET", "/api/providers/oauth");
    expect(r.status).toBe(200);
    const ag = r.body.providers.find((p) => p.id === "antigravity");
    expect(ag).toBeDefined();
    expect(ag.name).toBe("Antigravity");
    expect(ag.marker).toBe("antigravity-oauth");
    expect(ag.defaultPrefix).toBe("ag");
    expect(ag.models.length).toBeGreaterThan(10);
  });

  it("starts an Antigravity create flow and returns auth URL", async () => {
    const r = await req("POST", "/api/providers/antigravity/oauth/start", {
      intent: "create",
      name: "Google AG",
      prefix: "ag",
    }, { "x-routy-action": "1" });
    expect(r.status).toBe(200);
    expect(r.body.flowId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.verificationUrl).toContain("accounts.google.com");
  });

  it("409s duplicate prefix before starting flow", async () => {
    reposApi.nodes.create({ name: "Existing", prefix: "ag", apiType: "openai", baseUrl: "http://example.com" });
    const r = await req("POST", "/api/providers/antigravity/oauth/start", {
      intent: "create",
      name: "Google AG",
      prefix: "ag",
    }, { "x-routy-action": "1" });
    expect(r.status).toBe(409);
  });
});
