// CLI tools tests.
//
// These write into a config file the user owns, so the tests are about the two ways
// that goes wrong: clobbering something we did not mean to touch, and failing to put
// back exactly what was there. Every test drives a real file in a temp home and
// asserts on the bytes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTERS, allStatuses, connectTool, disconnectTool, findAdapter, findBinary, resolveFile, toolStatus } from "../core/cli-tools.mjs";

let home, repos;

/** The same settings surface the real repos expose. */
function fakeRepos() {
  const state = {};
  return {
    settings: {
      get: (k, fallback) => (k in state ? state[k] : fallback),
      update: (patch) => Object.assign(state, patch),
    },
  };
}

const claude = ADAPTERS.find((a) => a.id === "claude");
const codex = ADAPTERS.find((a) => a.id === "codex");
const claudePath = () => path.join(home, ".claude", "settings.json");
const codexPath = () => path.join(home, ".codex", "config.toml");
const piPath = () => path.join(home, ".pi", "agent", "models.json");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "routy-cli-"));
  repos = fakeRepos();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("adapter table", () => {
  it("has a unique id per tool", () => {
    const ids = ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares everything the engine needs", () => {
    for (const a of ADAPTERS) {
      // Copilot is a VS Code extension with no binary; detection is config-based.
      expect(Array.isArray(a.binaries), a.id).toBe(true);
      for (const file of a.files ?? []) {
        expect(file.path, a.id).toMatch(/^~\//);
        expect(["json", "jsonc", "toml", "yaml", "env"], a.id).toContain(file.format);
        // most adapters declare a patch; omp edits the text directly via apply()
        expect(typeof (file.patch ?? file.apply), `${a.id}:${file.path}`).toBe("function");
      }
      // devin is detection-only: no local file to write
      if (a.id !== "devin") expect(a.files.length, a.id).toBeGreaterThan(0);
    }
  });

  it("returns null for an unknown tool", () => {
    expect(findAdapter("nope")).toBe(null);
  });
});

describe("detection", () => {
  it("finds a binary that is on PATH", () => {
    const found = findBinary([process.platform === "win32" ? "node" : "node"]);
    expect(found).toBeTruthy();
  });

  it("returns null for a binary that does not exist", () => {
    expect(findBinary(["definitely-not-a-real-cli-tool-xyz"])).toBe(null);
  });

  it("reports a tool as installed when only its config exists", () => {
    write(claudePath(), "{}\n");
    const status = toolStatus(repos, claude, { home });
    expect(status.installed).toBe(true);
    expect(status.configExists).toBe(true);
  });

  it("reports a tool as not installed when neither binary nor config is present", () => {
    const fake = { ...claude, binaries: ["definitely-not-real-xyz"], config: "~/.nothing-here/settings.json" };
    const status = toolStatus(repos, fake, { home });
    expect(status.installed).toBe(false);
    expect(status.connected).toBe(false);
  });

  it("lists every adapter", () => {
    expect(allStatuses(repos, { home })).toHaveLength(ADAPTERS.length);
  });
});

describe("claude (json)", () => {
  const ORIGINAL = `${JSON.stringify(
    { model: "opus", env: { ANTHROPIC_BASE_URL: "http://old.example/v1", KEEP_ME: "yes" }, hooks: { a: 1 } },
    null,
    2,
  )}\n`;

  it("writes the gateway settings and leaves everything else alone", () => {
    write(claudePath(), ORIGINAL);
    const r = connectTool(repos, "claude", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk-1", model: "bai/x", home });
    expect(r.ok).toBe(true);

    const after = JSON.parse(fs.readFileSync(claudePath(), "utf8"));
    expect(after.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8010/v1");
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-1");
    expect(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("bai/x");
    expect(after.hasCompletedOnboarding).toBe(true);
    // untouched
    expect(after.env.KEEP_ME).toBe("yes");
    expect(after.hooks).toEqual({ a: 1 });
    expect(after.model).toBe("opus");
  });

  it("restores the file byte for byte on disconnect", () => {
    write(claudePath(), ORIGINAL);
    connectTool(repos, "claude", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk-1", model: "bai/x", home });
    const r = disconnectTool(repos, "claude");

    expect(r.ok).toBe(true);
    // the previous BASE_URL value comes back, it is not simply deleted — proven by
    // the byte-for-byte comparison below
    expect(r.restored.length).toBeGreaterThan(0);
    expect(fs.readFileSync(claudePath(), "utf8")).toBe(ORIGINAL);
  });

  it("removes a config file it created, rather than leaving a stub", () => {
    expect(fs.existsSync(claudePath())).toBe(false);
    connectTool(repos, "claude", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk-1", home });
    expect(fs.existsSync(claudePath())).toBe(true);

    disconnectTool(repos, "claude");
    expect(fs.existsSync(claudePath())).toBe(false);
  });

  it("reports connected, and which gateway", () => {
    write(claudePath(), ORIGINAL);
    expect(toolStatus(repos, claude, { home }).baseUrl).toBe("http://old.example/v1");

    connectTool(repos, "claude", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk-1", home });
    const status = toolStatus(repos, claude, { home });
    expect(status.connected).toBe(true);
    expect(status.baseUrl).toBe("http://127.0.0.1:8010/v1");
    expect(status.managed).toBe(true); // routy wrote it, so it can revert it
  });

  it("tolerates a config with trailing commas", () => {
    write(claudePath(), '{\n  "env": { "KEEP": "1", },\n}\n');
    const r = connectTool(repos, "claude", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk-1", home });
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(claudePath(), "utf8")).env.KEEP).toBe("1");
  });

  it("refuses a config it cannot parse instead of replacing it", () => {
    write(claudePath(), "{ this is not json");
    const r = connectTool(repos, "claude", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk-1", home });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unparseable_config");
    expect(fs.readFileSync(claudePath(), "utf8")).toBe("{ this is not json");
  });
});

describe("codex (toml)", () => {
  const ORIGINAL = [
    'model = "cx/gpt-5.5"',
    'model_provider = "other"',
    "",
    "# a comment that must survive",
    "[model_providers.other]",
    'name = "Other"',
    'base_url = "http://old.example/v1"',
    "",
  ].join("\n");

  it("adds its own provider and keeps the existing one and the comments", () => {
    write(codexPath(), ORIGINAL);
    const r = connectTool(repos, "codex", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: null, home });
    expect(r.ok).toBe(true);

    const after = fs.readFileSync(codexPath(), "utf8");
    expect(after).toContain("# a comment that must survive");
    expect(after).toContain("[model_providers.other]");
    expect(after).toContain("[model_providers.routy]");
    expect(after).toMatch(/model_provider = "routy"/);
    expect(after).toContain('base_url = "http://127.0.0.1:8010/v1"');
    expect(after).toContain('wire_api = "responses"');
  });

  it("restores the file byte for byte, including the previous provider", () => {
    write(codexPath(), ORIGINAL);
    connectTool(repos, "codex", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: null, home });
    const r = disconnectTool(repos, "codex");

    expect(r.ok).toBe(true);
    expect(r.restored.length).toBeGreaterThan(0);
    expect(fs.readFileSync(codexPath(), "utf8")).toBe(ORIGINAL);
  });
});

describe("pi (jsonc)", () => {
  it("writes the models pi can offer, and leaves its other providers alone", () => {
    // pi lists a provider's models from ITS OWN config, not from the provider's /v1/models.
    // `baseUrl` alone only redirects a provider pi already knows — so routy registered as
    // connected while pi's /model showed nothing at all.
    write(piPath(), JSON.stringify({ providers: { other: { baseUrl: "https://example.test/v1", api: "openai-completions", models: [{ id: "keep-me" }] } } }, null, 2));

    const r = connectTool(repos, "pi", {
      baseUrl: "http://127.0.0.1:8010/v1",
      apiKey: "sk-routy",
      availableModels: ["bai/deepseek-v4.1-flash", "dev"],
      home,
    });
    expect(r.ok).toBe(true);

    const written = JSON.parse(fs.readFileSync(piPath(), "utf8"));
    expect(written.providers.other.models).toEqual([{ id: "keep-me" }]);
    expect(written.providers.routy).toEqual({
      name: "routy",
      baseUrl: "http://127.0.0.1:8010/v1",
      apiKey: "sk-routy",
      api: "openai-completions", // pi needs the API type for a provider it does not know
      models: [{ id: "bai/deepseek-v4.1-flash" }, { id: "dev" }],
    });
  });

  it("omits models rather than writing an empty list when the gateway has none", () => {
    const r = connectTool(repos, "pi", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk", availableModels: [], home });
    expect(r.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(piPath(), "utf8"));
    expect(written.providers.routy.baseUrl).toBe("http://127.0.0.1:8010/v1");
    expect("models" in written.providers.routy).toBe(false);
  });

  it("restores every value on disconnect, leaving the other provider intact", () => {
    // Values, not bytes: jsonc is parse → set → serialise, so a round trip normalises
    // formatting (toml and yaml use text edits instead, for exactly that reason). What the
    // engine promises is that every path it touched goes back to what it was and nothing else
    // moves — asserted here as the same object plus no leftover provider.
    const original = { providers: { other: { baseUrl: "https://example.test/v1", models: [{ id: "keep-me" }] } } };
    write(piPath(), JSON.stringify(original));

    connectTool(repos, "pi", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk", availableModels: ["a/b"], home });
    expect(JSON.parse(fs.readFileSync(piPath(), "utf8")).providers.routy).toBeTruthy();

    const r = disconnectTool(repos, "pi");
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(piPath(), "utf8"))).toEqual(original);
  });
});

describe("failure modes", () => {
  it("rejects an unknown tool", () => {
    expect(connectTool(repos, "nope", { baseUrl: "http://x/v1" }).error).toBe("unknown_tool");
    expect(disconnectTool(repos, "nope").error).toBe("unknown_tool");
  });

  it("requires a base url", () => {
    expect(connectTool(repos, "claude", {}).error).toBe("bad_request");
  });

  it("will not disconnect a tool routy never wrote", () => {
    write(claudePath(), "{}\n");
    const r = disconnectTool(repos, "claude");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_connected_by_routy");
    expect(fs.readFileSync(claudePath(), "utf8")).toBe("{}\n");
  });

  it("does not leave a backup behind after disconnecting", () => {
    write(claudePath(), "{}\n");
    connectTool(repos, "claude", { baseUrl: "http://127.0.0.1:8010/v1", apiKey: "sk-1", home });
    expect(toolStatus(repos, claude, { home }).managed).toBe(true);
    disconnectTool(repos, "claude");
    expect(toolStatus(repos, claude, { home }).managed).toBe(false);
  });
});

// Every adapter gets the same treatment: a realistic empty-ish config, a connect, a
// read-back, and a disconnect that must restore the bytes exactly. Table-driven so a
// new adapter cannot be added without being covered.
describe("every adapter round-trips", () => {
  const writable = ADAPTERS.filter((a) => a.files?.length);

  /** An empty config of the right shape for each format. */
  const seed = (format) => (format === "json" || format === "jsonc" ? "{}\n" : format === "toml" ? 'name = "existing"\n' : "");

  for (const adapter of writable) {
    it(`${adapter.id}: connects, reports connected, and reverts byte-exactly`, () => {
      // lay down the files this adapter touches
      const before = new Map();
      for (const entry of adapter.files) {
        const file = resolveFile(entry, home);
        write(file, seed(entry.format));
        before.set(file, fs.readFileSync(file, "utf8"));
      }

      const r = connectTool(repos, adapter.id, {
        baseUrl: "http://127.0.0.1:8010/v1",
        apiKey: "sk-test",
        model: "bai/model",
        home,
      });
      expect(r.ok, `${adapter.id}: ${r.detail ?? ""}`).toBe(true);
      expect(r.files.length).toBeGreaterThan(0);

      // the tool now reads as connected
      const status = toolStatus(repos, adapter, { home });
      expect(status.connected, adapter.id).toBe(true);
      expect(status.managed, adapter.id).toBe(true);

      // and disconnecting puts every byte back
      const back = disconnectTool(repos, adapter.id);
      expect(back.ok, adapter.id).toBe(true);
      for (const [file, text] of before) {
        expect(fs.readFileSync(file, "utf8"), `${adapter.id}: ${file}`).toBe(text);
      }
      expect(toolStatus(repos, adapter, { home }).managed, adapter.id).toBe(false);
    }, 20_000);
  }

  it("covers every writable adapter", () => {
    expect(writable.length).toBe(ADAPTERS.length - 1); // devin is detection-only
  });
});

describe("binary detection", () => {
  it("finds a tool in ~/.local/bin even when PATH does not include it", () => {
    // The case that broke on a real server: systemd hands a service a minimal PATH
    // (/usr/bin:/bin), so anything installed under the user's home is invisible to it.
    // That is exactly where these tools live — pipx, uv, cargo and friends all write
    // to ~/.local/bin — and the dashboard reported "not installed" for a tool that was
    // installed and worked fine in the user's own shell.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "routy-bin-"));
    const dir = path.join(home, ".local", "bin");
    fs.mkdirSync(dir, { recursive: true });
    const name = process.platform === "win32" ? "routytest-bin.cmd" : "routytest-bin";
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });

    const saved = process.env.PATH;
    process.env.PATH = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin";
    try {
      expect(findBinary(["routytest-bin"], { home })).toBe(path.join(dir, name));
      // and a tool that really is absent stays absent
      expect(findBinary(["routytest-absent-xyz"], { home })).toBeNull();
      // no names is not a crash
      expect(findBinary([], { home })).toBeNull();
    } finally {
      process.env.PATH = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks a tool installed when only its binary is present, with no config yet", () => {
    // A freshly installed CLI has a binary and no config. That is "installed", and it
    // is the state a user is most likely to be in when they open this screen.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "routy-bin-"));
    const dir = path.join(home, ".local", "bin");
    fs.mkdirSync(dir, { recursive: true });
    const name = process.platform === "win32" ? "routytest-bin2.cmd" : "routytest-bin2";
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
    const adapter = { id: "t", name: "T", binaries: ["routytest-bin2"], files: [{ path: "~/.nope-xyz/config", format: "json" }] };

    const saved = process.env.PATH;
    process.env.PATH = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin";
    try {
      const status = toolStatus(repos, adapter, { home });
      expect(status.installed).toBe(true);
      expect(status.configExists).toBe(false);
      expect(status.connected).toBe(false);
    } finally {
      process.env.PATH = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
