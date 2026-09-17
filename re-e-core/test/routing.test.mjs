// P1.3 routing tests — resolution precedence, markers, aliases, combos, breakers.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { resolveRoute, stripContextMarker, listModels, isNodeHealthy } from "../core/routing.mjs";

let tmp, db, repos;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-route-"));
  db = openDatabase(tmp);
  repos = createRepos(db);
  repos.nodes.create({ name: "Mine", prefix: "mine", apiType: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  repos.nodes.create({ name: "Down", prefix: "down", apiType: "openai", baseUrl: "http://127.0.0.1:9/v2", enabled: false });
  repos.aliases.set("fast", "mine/gpt-fast");
  repos.aliases.set("loop-a", "loop-b");
  repos.aliases.set("loop-b", "loop-a");
  repos.combos.create({ name: "dev", models: ["mine/a", "down/b", "mine/c"] });
});

describe("stripContextMarker", () => {
  it("strips [1m]-style markers", () => {
    expect(stripContextMarker("mine/gpt-x[1m]")).toEqual({ modelStr: "mine/gpt-x", marker: "1m" });
    expect(stripContextMarker("mine/gpt-x")).toEqual({ modelStr: "mine/gpt-x", marker: null });
  });
});

describe("resolveRoute", () => {
  it("resolves node prefix routes", () => {
    const r = resolveRoute(repos, "mine/gpt-x");
    expect(r.kind).toBe("node");
    expect(r.node.prefix).toBe("mine");
    expect(r.model).toBe("gpt-x");
    expect(r.healthy).toBe(true);
  });

  it("resolves aliases to their target route and keeps markers", () => {
    const r = resolveRoute(repos, "fast[1m]");
    expect(r.kind).toBe("node");
    expect(r.model).toBe("gpt-fast");
    expect(r.marker).toBe("1m");
  });

  it("does not hang on alias loops", () => {
    expect(resolveRoute(repos, "loop-a")).toBeNull();
  });

  it("resolves combos with per-route health", () => {
    const r = resolveRoute(repos, "dev");
    expect(r.kind).toBe("combo");
    expect(r.routes).toHaveLength(3);
    expect(r.routes[0].healthy).toBe(true);
    expect(r.routes[1].healthy).toBe(false); // disabled node
    expect(r.routes[1].node.prefix).toBe("down");
  });

  it("flags routes unhealthy when breaker is open and not expired", () => {
    const node = repos.nodes.byPrefix("mine");
    repos.breakers.record(`node:${node.id}`, {
      state: "open",
      openUntil: new Date(Date.now() + 60_000).toISOString(),
      failureDelta: 1,
    });
    expect(resolveRoute(repos, "mine/x").healthy).toBe(false);
  });

  it("treats an expired open breaker as healthy (half-open candidate)", () => {
    const node = repos.nodes.byPrefix("mine");
    repos.breakers.record(`node:${node.id}`, {
      state: "open",
      openUntil: new Date(Date.now() - 1000).toISOString(),
      failureDelta: 1,
    });
    expect(resolveRoute(repos, "mine/x").healthy).toBe(true);
  });

  it("returns null for unknown models", () => {
    expect(resolveRoute(repos, "nope/x")).toBeNull();
    expect(resolveRoute(repos, "alias-only-no-slash")).toBeNull();
  });
});

describe("isNodeHealthy", () => {
  it("handles absent breaker and malformed openUntil", () => {
    const node = repos.nodes.byPrefix("mine");
    expect(isNodeHealthy(repos, node)).toBe(true);
    repos.breakers.record(`node:${node.id}`, { state: "open", openUntil: "not-a-date" });
    // Date.parse("not-a-date") is NaN → NaN > now is false → expired → healthy
    expect(isNodeHealthy(repos, node)).toBe(true);
  });
});

describe("listModels", () => {
  it("includes aliases, combos, and node prefixes", () => {
    const { data } = listModels(repos);
    const ids = data.map((m) => m.id);
    expect(ids).toContain("fast");
    expect(ids).toContain("dev");
    expect(ids).toContain("mine/*");
    expect(ids).not.toContain("down/*"); // disabled node excluded
  });
});
