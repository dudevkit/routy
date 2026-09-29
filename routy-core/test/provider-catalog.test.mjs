// Provider preset catalogue (freeTier + free): the honest card lists the Providers screen renders.
// The facts asserted here are the ones a bad entry would break — membership per category,
// endpoint shape (routy posts to node.baseUrl verbatim, no urlSuffix), and the no-preset rule
// for what routy cannot serve.
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../core/providerCatalog.mjs";

const FREE_TIER_IDS = ["api-airforce", "bazaarlink", "byteplus", "cloudflare-ai", "kilo-gateway", "nvidia", "openrouter", "poolside"];
const FREE_IDS = ["mimo-free"];

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
      // routing.mjs sends chat to node.baseUrl verbatim — an endpoint, not a directory,
      // and nothing appended later (the generator rejects urlSuffix entries outright).
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
    expect(unsupported.length).toBe(14);
    for (const e of unsupported) {
      expect(e.why, e.id).toBeTruthy();
      expect(e.why.length, e.id).toBeGreaterThan(20);
    }
  });

  it("local/TTS entries without an endpoint are never supported", () => {
    for (const id of ["coqui", "edge-tts", "google-tts", "local-device", "tortoise", "searxng"]) {
      const e = PROVIDERS.find((x) => x.id === id);
      expect(e.supported, id).toBe(false);
      expect(e.baseUrl, id).toBeFalsy();
    }
  });

  it("the no-auth category: only mimo-free survives (stdio, wire dialects and a website URL do not)", () => {
    const free = byCategory("free");
    expect(free.filter((e) => e.supported).map((e) => e.id)).toEqual(FREE_IDS);
    const devin = PROVIDERS.find((e) => e.id === "devin-cli");
    expect(devin.baseUrl).toMatch(/^devin:\/\//);
    const opencode = PROVIDERS.find((e) => e.id === "opencode");
    expect(opencode.supported).toBe(false);
    expect(new URL(opencode.baseUrl).pathname).toBe("/"); // the website, not an endpoint
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
});
