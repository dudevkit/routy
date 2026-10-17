// CodeBuddy Intl OAuth — protocol client, flow manager, credentials, executor.
//
// All provider calls are injected: no test reaches the network, so none spends quota.
// The live state request that pinned the verification hostname is a one-off recorded in
// docs/codebuddy-intl-oauth-design.md; it is NOT repeated here.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateVerificationUrl,
  normalizeTokens,
  credentialFromTokens,
  startFlow,
  pollFlow,
  refreshTokens,
  fetchModels,
  OAuthError,
  CODEBUDDY_INTL,
} from "../core/oauth/codebuddyIntl.mjs";
import { createFlowManager, FlowLimitError, FlowNotFoundError, FlowRateError, MAX_FLOWS } from "../core/oauth/flowManager.mjs";
import { transformCodebuddyBody, codebuddyChatHeaders, CodeBuddyIntlExecutor, isCodeBuddyIntlOAuth } from "../core/executors/codebuddyIntl.mjs";

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.restoreAllMocks(); });

describe("verification URL allowlist", () => {
  it("accepts both equivalent hosts", () => {
    expect(validateVerificationUrl("https://www.workbuddy.ai/login?platform=ide&state=abc"))
      .toBe("https://www.workbuddy.ai/login?platform=ide&state=abc");
    expect(validateVerificationUrl("https://www.codebuddy.ai/login?platform=ide&state=abc"))
      .toBe("https://www.codebuddy.ai/login?platform=ide&state=abc");
  });
  it("rejects a suffix-confusable host", () => {
    expect(() => validateVerificationUrl("https://evil-www.workbuddy.ai/login")).toThrow(OAuthError);
    expect(() => validateVerificationUrl("https://www.workbuddy.ai.evil.com/login")).toThrow(OAuthError);
    expect(() => validateVerificationUrl("https://evil-www.codebuddy.ai/login")).toThrow(OAuthError);
    expect(() => validateVerificationUrl("https://www.codebuddy.ai.evil.com/login")).toThrow(OAuthError);
  });
  it("rejects non-https, credentials, and fragments", () => {
    expect(() => validateVerificationUrl("http://www.workbuddy.ai/login")).toThrow(/non-HTTPS/);
    expect(() => validateVerificationUrl("https://user:pw@www.workbuddy.ai/login")).toThrow(/credentials/);
    expect(() => validateVerificationUrl("https://www.workbuddy.ai/login#x")).toThrow(/fragment/);
    expect(() => validateVerificationUrl("not a url")).toThrow(OAuthError);
  });
});

describe("token normalization", () => {
  it("requires an access token and accepts bearer", () => {
    expect(() => normalizeTokens({}, null)).toThrow(/access token/);
    expect(normalizeTokens({ accessToken: "at", expiresIn: 3600 }, null))
      .toMatchObject({ accessToken: "at", expiresInSec: 3600, tokenType: "Bearer" });
  });
  it("rejects an unsupported token type and a malformed expiry", () => {
    expect(() => normalizeTokens({ accessToken: "at", tokenType: "mac" }, null)).toThrow(/unsupported token type/);
    expect(() => normalizeTokens({ accessToken: "at", expiresIn: 0 }, null)).toThrow(/invalid token expiry/);
    expect(() => normalizeTokens({ accessToken: "at", expiresIn: -5 }, null)).toThrow(/invalid token expiry/);
    expect(() => normalizeTokens({ accessToken: "at", expiresIn: "soon" }, null)).toThrow(/invalid token expiry/);
  });
  it("defaults only an omitted expiry and retains the prior refresh token", () => {
    expect(normalizeTokens({ accessToken: "at" }, null).expiresInSec).toBe(CODEBUDDY_INTL.defaultExpiresInSec);
    expect(normalizeTokens({ accessToken: "at" }, "old-refresh").refreshToken).toBe("old-refresh");
  });
  it("builds an OAuth credential with an incremented revision", () => {
    const c = credentialFromTokens({ accessToken: "at", refreshToken: "rt", expiresInSec: 60 }, { now: 1000, previousRevision: 4 });
    expect(c).toMatchObject({ authType: "oauth", accessToken: "at", refreshToken: "rt", authState: "active", oauthRevision: 5 });
    expect(Date.parse(c.expiresAt)).toBe(1000 + 60_000);
  });
});

describe("startFlow", () => {
  it("returns a validated verification URL and never exposes the upstream state to the caller shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 0, data: { state: "st-1", authUrl: "https://www.workbuddy.ai/login?platform=ide&state=st-1" } })));
    const r = await startFlow({});
    expect(r.upstreamState).toBe("st-1");
    expect(r.verificationUrl).toContain("www.workbuddy.ai/login");
  });
  it("fails closed on an untrusted verification host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 0, data: { state: "st", authUrl: "https://evil.example.com/login" } })));
    await expect(startFlow({})).rejects.toThrow(/not allowlisted/);
  });
  it("maps a non-2xx and a bad body to sanitized errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { msg: "boom secret-token" })));
    await expect(startFlow({})).rejects.toMatchObject({ code: "upstream_error" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 7, msg: "nope" })));
    await expect(startFlow({})).rejects.toMatchObject({ code: "upstream_bad_response" });
  });
});

describe("pollFlow", () => {
  it("reports pending on 11217 and success on code 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 11217 })));
    expect((await pollFlow("st")).state).toBe("pending");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 0, data: { accessToken: "at", refreshToken: "rt", expiresIn: 3600 } })));
    const done = await pollFlow("st");
    expect(done.state).toBe("complete");
    expect(done.tokens.accessToken).toBe("at");
  });
  it("keeps polling on a non-2xx (transient from the flow's view)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, {})));
    expect((await pollFlow("st")).state).toBe("pending");
  });
});

describe("refreshTokens", () => {
  it("returns rotated tokens and flags a 5xx transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 0, data: { accessToken: "at2", refreshToken: "rt2", expiresIn: 3600 } })));
    const t = await refreshTokens("rt");
    expect(t).toMatchObject({ accessToken: "at2", refreshToken: "rt2" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { msg: "leaky" })));
    await expect(refreshTokens("rt")).rejects.toMatchObject({ transient: true });
  });
  it("does not classify an ambiguous provider code as definitive (transient, no false revocation)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 40003, msg: "unknown" })));
    await expect(refreshTokens("rt")).rejects.toMatchObject({ transient: true, code: "refresh_rejected" });
  });
});

describe("fetchModels", () => {
  it("returns de-duplicated ids from /v3/config and sends a WorkBuddy User-Agent", async () => {
    const seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
      seen.push({ url: String(url), ua: opts.headers?.["User-Agent"] });
      return jsonResponse(200, { code: 0, data: { models: [{ id: "glm-5.2" }, { id: "glm-5.2" }, { id: "kimi-k3" }, { name: "no-id" }] } });
    }));
    const ids = await fetchModels("at");
    expect(ids).toEqual(["glm-5.2", "kimi-k3"]);
    expect(seen[0].url).toBe(CODEBUDDY_INTL.configUrl);
    expect(String(seen[0].ua).toLowerCase()).toContain("workbuddy");
  });

  it("refuses without a token and sanitizes an upstream failure", async () => {
    await expect(fetchModels(null)).rejects.toMatchObject({ code: "no_credentials" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { msg: "ua required" })));
    await expect(fetchModels("at")).rejects.toMatchObject({ code: "upstream_error" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { code: 0, data: {} })));
    await expect(fetchModels("at")).rejects.toMatchObject({ code: "upstream_bad_response" });
  });
});

describe("flow manager arbitration", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("commits once and reports a safe terminal result", async () => {
    const fm = createFlowManager();
    const { flowId } = fm.create({ intent: { kind: "create" }, verificationUrl: "u", upstreamState: "st", commit: () => ({ node: { id: "n1" } }) });
    const out = await fm.poll(flowId, async () => ({ state: "complete", tokens: { accessToken: "at" } }));
    expect(out.state).toBe("complete");
    expect(out.node.id).toBe("n1");
    fm.stop();
  });

  it("discards tokens when cancel wins while the poll is in flight", async () => {
    const fm = createFlowManager();
    let committed = false;
    const { flowId } = fm.create({ intent: {}, verificationUrl: "u", upstreamState: "st", commit: () => { committed = true; return {}; } });
    const pending = fm.poll(flowId, async () => { await new Promise((r) => setTimeout(r, 5)); return { state: "complete", tokens: { accessToken: "at" } }; });
    // Cancel lands during the await.
    await flush();
    const cancelResult = fm.cancel(flowId);
    expect(cancelResult.state).toBe("cancelled");
    const pollResult = await pending;
    expect(committed).toBe(false);
    expect(pollResult.state).toBe("cancelled");
    fm.stop();
  });

  it("returns the completed result when commit wins before cancel", async () => {
    const fm = createFlowManager();
    const { flowId } = fm.create({ intent: {}, verificationUrl: "u", upstreamState: "st", commit: () => ({ node: { id: "n2" } }) });
    const out = await fm.poll(flowId, async () => ({ state: "complete", tokens: { accessToken: "at" } }));
    expect(out.state).toBe("complete");
    expect(fm.cancel(flowId).state).toBe("complete");
    fm.stop();
  });

  it("rejects more than one upstream poll per interval", async () => {
    const fm = createFlowManager();
    const { flowId } = fm.create({ intent: {}, verificationUrl: "u", upstreamState: "st", commit: () => ({}) });
    await fm.poll(flowId, async () => ({ state: "pending" }));
    await expect(fm.poll(flowId, async () => ({ state: "pending" }))).rejects.toBeInstanceOf(FlowRateError);
    fm.stop();
  });

  it("caps outstanding flows and rejects an unknown id", () => {
    const fm = createFlowManager();
    for (let i = 0; i < MAX_FLOWS; i++) fm.create({ intent: {}, verificationUrl: "u", upstreamState: "s", commit: () => ({}) });
    expect(() => fm.create({ intent: {}, verificationUrl: "u", upstreamState: "s", commit: () => ({}) })).toThrow(FlowLimitError);
    expect(() => fm.cancel("nope")).toThrow(FlowNotFoundError);
    fm.stop();
  });

  it("expires a flow past its deadline without committing", async () => {
    let t = 1000;
    const fm = createFlowManager({ now: () => t });
    const { flowId } = fm.create({ intent: {}, verificationUrl: "u", upstreamState: "s", expiresAt: 2000, commit: () => ({ node: {} }) });
    t = 5000;
    const out = await fm.poll(flowId, async () => ({ state: "complete", tokens: {} }));
    expect(out.state).toBe("failed");
    expect(out.error.code).toBe("flow_expired");
    fm.stop();
  });
});

describe("executor", () => {
  it("recognizes only the server-owned marker", () => {
    expect(isCodeBuddyIntlOAuth({ data: { authProvider: "codebuddy-intl-oauth" } })).toBe(true);
    expect(isCodeBuddyIntlOAuth({ data: { executor: "codebuddy-intl" } })).toBe(false);
    expect(isCodeBuddyIntlOAuth({})).toBe(false);
  });

  it("forces stream, keeps the client system prompt, types user content, drops a second system turn", () => {
    const b = transformCodebuddyBody("glm-5.2", {
      stream: false,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "You are Alice, a helpful agent." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "developer", content: "second system turn" },
      ],
    });
    expect(b.stream).toBe(true);
    expect(b.reasoning_summary).toBe("auto");
    // The caller's persona is preserved and stays first (a second system/developer turn
    // folds into the same leading message — CodeBuddy takes one leading system turn).
    expect(b.messages[0].role).toBe("system");
    expect(b.messages[0].content).toContain("You are Alice, a helpful agent.");
    expect(b.messages[0].content).toContain("second system turn");
    expect(b.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(b.messages[2]).toEqual({ role: "assistant", content: "hello" });
    expect(b.messages).toHaveLength(3);
    expect(JSON.stringify(b.messages)).not.toContain("You are CodeBuddy Code.");
  });

  it("adds the CodeBuddy identity line only when the caller sent no system prompt", () => {
    const b = transformCodebuddyBody("m", { messages: [{ role: "user", content: "hi" }] });
    expect(b.messages[0]).toEqual({ role: "system", content: "You are CodeBuddy Code." });
  });

  it("folds a developer turn into the leading system message", () => {
    const b = transformCodebuddyBody("m", { messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "hi" }] });
    expect(b.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(b.messages).toHaveLength(2);
  });

  it("drops a 'none' effort instead of forwarding it", () => {
    const b = transformCodebuddyBody("m", { reasoning_effort: "none", messages: [] });
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.reasoning_summary).toBeUndefined();
  });

  it("uses the fixed endpoint and the OAuth bearer token", () => {
    const ex = new CodeBuddyIntlExecutor(
      { prefix: "cb", baseUrl: "https://example.com/v1", apiType: "openai", data: { authProvider: "codebuddy-intl-oauth" } },
      { credentials: { authType: "oauth", accessToken: "AT" } },
    );
    expect(ex.buildUrl()).toBe(CODEBUDDY_INTL.chatUrl);
    const headers = ex.buildHeaders();
    expect(headers.authorization).toBe("Bearer AT");
    expect(headers["x-codebuddy-request"]).toBe("1");
  });

  it("carries the five conversation headers the gateway's channel check requires", () => {
    const CONVO = [
      "X-Conversation-ID", "X-Parent-Conversation-ID", "X-Conversation-Request-ID",
      "X-Conversation-Message-ID", "X-Session-ID",
    ];
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const first = codebuddyChatHeaders();
    for (const h of CONVO) expect(first[h]).toMatch(UUID);
    // fresh per call: these are per-request correlation ids, never reused
    const second = codebuddyChatHeaders();
    for (const h of CONVO) expect(second[h]).not.toBe(first[h]);
    // identity rides only when a verified uid exists — never invented
    expect(first["X-User-Id"]).toBeUndefined();
    expect(first["X-Domain"]).toBeUndefined();
    const withUid = codebuddyChatHeaders("uid-42");
    expect(withUid["X-User-Id"]).toBe("uid-42");
    expect(withUid["X-Domain"]).toBe(CODEBUDDY_INTL.host);
    // and the executor forwards the connection's uid
    const ex = new CodeBuddyIntlExecutor(
      { prefix: "cb", baseUrl: "x", data: { authProvider: "codebuddy-intl-oauth" } },
      { credentials: { authType: "oauth", accessToken: "AT", providerSpecificData: { quotaIdentity: { uid: "uid-42" } } } },
    );
    expect(ex.buildHeaders()["X-User-Id"]).toBe("uid-42");
  });

  it("sanitizes error bodies so token-shaped text never escapes", () => {
    const ex = new CodeBuddyIntlExecutor({ prefix: "cb", baseUrl: "x", data: {} }, { credentials: {} });
    const msg = ex.errorMessage(401, "access_token=super-secret refresh_token=also-secret");
    expect(msg).not.toContain("secret");
    expect(msg).toContain("401");
    expect(codebuddyChatHeaders()["User-Agent"]).toContain("CodeBuddy");
  });
});
