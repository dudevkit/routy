// Log redaction is a security control with a usability cost, and the two pull against
// each other: an over-broad rule makes the console useless (it hid promptTokens and
// completionTokens, because "…Tokens" contains "token"), an under-broad one leaks
// credentials. These tests pin both directions so neither drifts.
import { describe, it, expect } from "vitest";
import { redact } from "../lib/log.mjs";

describe("log redaction", () => {
  it("redacts credentials, including nested ones", () => {
    const out = redact({
      authorization: "Bearer sk-real-secret",
      apiKey: "sk-real-secret",
      api_key: "sk-real-secret",
      "api-key": "sk-real-secret",
      password: "hunter2",
      secret: "shhh",
      token: "raw-token",
      accessToken: "raw-token",
      refresh_token: "raw-token",
      credentials: { apiKey: "sk-nested-secret", label: "primary" },
    });
    for (const k of ["authorization", "apiKey", "api_key", "api-key", "password", "secret", "token", "accessToken", "refresh_token"]) {
      expect(out[k], k).toBe("[REDACTED]");
    }
    expect(out.credentials.apiKey).toBe("[REDACTED]");
    // a non-secret sibling inside the same object is untouched
    expect(out.credentials.label).toBe("primary");
  });

  it("keeps usage numbers and provenance labels, which are not secrets", () => {
    const out = redact({
      promptTokens: 7944,
      completionTokens: 544,
      cachedTokens: 128,
      totalTokens: 8488,
      tokensPerSec: 43.2,
      max_tokens: 4096,
      tokenField: "content",
      keyMasked: "sk-abc…9f3a",
      costUsd: 0.0021,
    });
    expect(out).toEqual({
      promptTokens: 7944,
      completionTokens: 544,
      cachedTokens: 128,
      totalTokens: 8488,
      tokensPerSec: 43.2,
      max_tokens: 4096,
      tokenField: "content",
      keyMasked: "sk-abc…9f3a",
      costUsd: 0.0021,
    });
  });

  it("redacts by field name inside arrays and at depth", () => {
    const out = redact({ connections: [{ name: "k1", apiKey: "sk-secret" }, { name: "k2", apiKey: "sk-secret" }] });
    expect(out.connections[0].apiKey).toBe("[REDACTED]");
    expect(out.connections[1].apiKey).toBe("[REDACTED]");
    expect(out.connections.map((c) => c.name)).toEqual(["k1", "k2"]);
  });
});
