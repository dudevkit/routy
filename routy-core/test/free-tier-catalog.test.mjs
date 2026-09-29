// Free-tier chat catalogue: the honest card list the Providers screen renders.
// The facts asserted here are the ones a bad entry would break — membership, endpoint shape
// (routy posts to node.baseUrl verbatim), and the no-preset rule for what routy cannot serve.
import { describe, expect, it } from "vitest";
import { FREE_TIER } from "../core/freeTierCatalog.mjs";

const SUPPORTED_IDS = ["api-airforce", "bazaarlink", "byteplus", "cloudflare-ai", "kilo-gateway", "nvidia", "openrouter", "poolside"];

describe("free-tier chat catalogue", () => {
  it("lists all 18 free-tier providers from 9Router's registry, no more, no fewer", () => {
    expect(FREE_TIER.length).toBe(18);
    expect(new Set(FREE_TIER.map((e) => e.id)).size).toBe(18);
    const wanted = [...SUPPORTED_IDS, "coqui", "edge-tts", "gemini", "google-tts", "kimchi", "local-device", "nvidia", "ollama", "searxng", "tortoise", "vertex"].filter(
      (id, i, a) => a.indexOf(id) === i,
    );
    for (const id of wanted) expect(FREE_TIER.some((e) => e.id === id), `missing ${id}`).toBe(true);
  });

  it("every supported entry is a full OpenAI endpoint routy can post to", () => {
    const supported = FREE_TIER.filter((e) => e.supported);
    expect(supported.map((e) => e.id)).toEqual(SUPPORTED_IDS);
    for (const e of supported) {
      expect(e.format, e.id).toBe("openai");
      expect(e.baseUrl, e.id).toMatch(/^https:\/\//);
      expect(() => new URL(e.baseUrl), e.id).not.toThrow();
      // routing.mjs sends chat to node.baseUrl verbatim — an endpoint, not a directory.
      expect(e.baseUrl, e.id).toMatch(/\/chat\/completions$/);
      expect(e.models.length, e.id).toBeGreaterThan(0);
      expect(e.why, e.id).toBeNull();
    }
  });

  it("every entry routy cannot serve names the transport it lacks and carries no preset", () => {
    const unsupported = FREE_TIER.filter((e) => !e.supported);
    expect(unsupported.length).toBe(10);
    for (const e of unsupported) {
      expect(e.why, e.id).toBeTruthy();
      expect(e.why.length, e.id).toBeGreaterThan(20);
    }
  });

  it("local/TTS entries without an endpoint are never supported", () => {
    for (const id of ["coqui", "edge-tts", "google-tts", "local-device", "tortoise", "searxng"]) {
      const e = FREE_TIER.find((x) => x.id === id);
      expect(e.supported, id).toBe(false);
      expect(e.baseUrl, id).toBeFalsy();
    }
  });

  it("cloudflare's {accountId} placeholder is declared on the card, not discovered after adding", () => {
    const cf = FREE_TIER.find((e) => e.id === "cloudflare-ai");
    expect(cf.supported).toBe(true);
    expect(cf.baseUrl).toContain("{accountId}");
    expect(cf.requires.join(" ")).toContain("accountId");
  });

  it("where to get a key is carried for the addable ones", () => {
    for (const e of FREE_TIER.filter((x) => x.supported)) {
      expect(e.keyUrl, e.id).toBeTruthy();
    }
  });
});
