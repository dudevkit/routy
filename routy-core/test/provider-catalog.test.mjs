// Provider preset catalogue (freeTier + free): the honest card lists the Providers screen renders.
// The facts asserted here are the ones a bad entry would break — membership per category,
// endpoint shape (routy posts to node.baseUrl verbatim, no urlSuffix), and the no-preset rule
// for what routy cannot serve.
import { describe, expect, it } from "vitest";
import { PROVIDERS, isKeyless } from "../core/providerCatalog.mjs";

const FREE_TIER_IDS = ["api-airforce", "bazaarlink", "byteplus", "cloudflare-ai", "kilo-gateway", "nvidia", "openrouter", "poolside"];
const FREE_IDS = ["mimo-free", "opencode"];

const byCategory = (cat) => PROVIDERS.filter((e) => e.category === cat);

describe("provider preset catalogue", () => {
  it("lists both registry addable categories in full: 18 freeTier + 5 free", () => {
    expect(PROVIDERS.length).toBe(23);
    expect(new Set(PROVIDERS.map((e) => e.id)).size).toBe(23);
    expect(byCategory("freeTier").length).toBe(18);
    expect(byCategory("free").length).toBe(5);
    for (const id of ["devin-cli", "gemini-cli", "kiro", "opencode"]) {
      expect(PROVIDERS.some((e) => e.id === id), `missing ${id}`).toBe(true);
    }
  });

  it("every supported entry is a full HTTP OpenAI endpoint routy can post to", () => {
    const supported = PROVIDERS.filter((e) => e.supported);
    expect(supported.map((e) => e.id)).toEqual([...FREE_TIER_IDS, ...FREE_IDS]);
    for (const e of supported) {
      expect(e.format, e.id).toBe("openai");
      expect(e.baseUrl, e.id).toMatch(/^https:\/\//);
      expect(() => new URL(e.baseUrl), e.id).not.toThrow();
      // routy's default buildUrl APPENDS /chat/completions (a hand-created node's convention
      // is a base path), so every preset except opencode carries its full registry endpoint
      // as data.chatUrl — posted to exactly as9Router posts it. Category "free" is keyless:
      // data.noAuth is what lets chat run it through the anonymous connection and probes run
      // without a key.
      if (e.id !== "opencode") expect(e.data?.chatUrl, e.id).toBe(e.baseUrl);
      expect(Boolean(e.data?.noAuth), `${e.id} noAuth`).toBe(e.category === "free");
      expect(e.why, e.id).toBeNull();
      expect(e.requires, e.id).toBeDefined();
    }
  });

  it("the freeTier supported set keeps its endpoint shape", () => {
    for (const e of byCategory("freeTier").filter((x) => x.supported)) {
      expect(e.baseUrl, e.id).toMatch(/\/chat\/completions$/);
      expect(e.models.length, e.id).toBeGreaterThan(0);
    }
  });

  it("every entry routy cannot serve names the transport it lacks and carries no preset", () => {
    const unsupported = PROVIDERS.filter((e) => !e.supported);
    expect(unsupported.length).toBe(13);
    for (const e of unsupported) {
      expect(e.why, e.id).toBeTruthy();
      expect(e.why.length, e.id).toBeGreaterThan(20);
      expect(e.data, e.id).toBeFalsy();
    }
  });

  it("local/TTS entries without an endpoint are never supported", () => {
    for (const id of ["coqui", "edge-tts", "google-tts", "local-device", "tortoise", "searxng"]) {
      const e = PROVIDERS.find((x) => x.id === id);
      expect(e.supported, id).toBe(false);
      expect(e.baseUrl, id).toBeFalsy();
    }
  });

  it("the no-auth category: mimo-free and opencode survive (stdio and wire dialects do not)", () => {
    const free = byCategory("free");
    expect(free.filter((e) => e.supported).map((e) => e.id)).toEqual(FREE_IDS);
    const devin = PROVIDERS.find((e) => e.id === "devin-cli");
    expect(devin.baseUrl).toMatch(/^devin:\/\//);
    // opencode's root URL is not the endpoint — it selects the ported executor instead
    // (core/executors/opencode.mjs composes /zen/v1/... per model).
    const oc = PROVIDERS.find((e) => e.id === "opencode");
    expect(oc.supported).toBe(true);
    expect(oc.data).toEqual({ executor: "opencode", noAuth: true });
    expect(new URL(oc.baseUrl).pathname).toBe("/");
  });

  it("cloudflare's {accountId} placeholder is declared on the card, not discovered after adding", () => {
    const cf = PROVIDERS.find((e) => e.id === "cloudflare-ai");
    expect(cf.supported).toBe(true);
    expect(cf.baseUrl).toContain("{accountId}");
    expect(cf.requires.join(" ")).toContain("accountId");
  });

  it("where to get a key is carried for the key-required supported ones", () => {
    for (const e of byCategory("freeTier").filter((x) => x.supported)) {
      expect(e.keyUrl, e.id).toBeTruthy();
    }
  });

  it("keylessness is decided from the catalogue, so a node saved before noAuth still runs", () => {
    // The stale-node case: preset + executor only, no data.noAuth — created before the flag
    // existed. Deriving from the shipped catalogue is what keeps it usable without surgery.
    expect(isKeyless({ data: { preset: "opencode", executor: "opencode" } })).toBe(true);
    expect(isKeyless({ data: { preset: "mimo-free" } })).toBe(true);
    expect(isKeyless({ data: { preset: "nvidia" } })).toBe(false);
    expect(isKeyless({ data: {} })).toBe(false);
    expect(isKeyless(null)).toBe(false);
  });
});
