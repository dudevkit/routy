// CLI tools — point a locally installed AI CLI at this gateway, from the dashboard.
//
// An adapter says how to notice the tool and what to write into its config. The
// engine supplies detection, backup and exact revert, so adding a tool is data.
//
// The revert is the part that matters. These are files the user owns, so before the
// first write every path about to be touched is snapshotted — value, or "was absent"
// — and disconnecting puts exactly those back. Unrelated keys are never rewritten.
//
// Some tools read two files (Cline keeps state and secrets apart; Hermes keeps a
// config and a .env), so an adapter is a list of files, not a single path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, deleteValues, getValue, setValues } from "../lib/formats.mjs";

/** Home-relative paths are expanded at use, never at import. */
const expand = (p, home = os.homedir()) => (p.startsWith("~") ? path.join(home, p.slice(1)) : p);

/** Windows keeps VS Code's user dir under %APPDATA%; the others are the same shape. */
const vscodeUserDir = (home) =>
  process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User")
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Code", "User")
      : path.join(home, ".config", "Code", "User");

/**
 * The adapter table.
 *
 * `patch(ctx)` returns `{ dottedPath: value }`. ctx is:
 *   baseUrl      http://127.0.0.1:8010/v1
 *   baseUrlNoV1  the same without the /v1 suffix (Cline wants it bare)
 *   apiKey, model, models
 *   get(dotted)  the current value in *this* file, for patches that must read
 *                before they write (whole arrays, model maps)
 */
export const ADAPTERS = [
  {
    id: "claude",
    name: "Claude Code",
    binaries: ["claude"],
    note: "Uses ANTHROPIC_AUTH_TOKEN, so it authenticates with `Authorization: Bearer`. routy also accepts the `x-api-key` header Claude Code sends when configured with ANTHROPIC_API_KEY.",
    files: [
      {
        path: "~/.claude/settings.json",
        format: "jsonc", // hand-edited, routinely carries trailing commas
        connectedWhen: "env.ANTHROPIC_BASE_URL",
        patch: ({ baseUrl, apiKey, model }) => ({
          "env.ANTHROPIC_BASE_URL": baseUrl,
          "env.ANTHROPIC_AUTH_TOKEN": apiKey,
          ...(model
            ? {
                "env.ANTHROPIC_DEFAULT_OPUS_MODEL": model,
                "env.ANTHROPIC_DEFAULT_SONNET_MODEL": model,
                "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
              }
            : {}),
          hasCompletedOnboarding: true, // else Claude Code shows its onboarding flow
        }),
      },
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    binaries: ["codex"],
    note: "Edited as text, so comments and your other providers survive. Codex keeps its own credential in ~/.codex/auth.json, which routy does not touch.",
    files: [
      {
        path: "~/.codex/config.toml",
        format: "toml",
        connectedWhen: "model_providers.routy.base_url",
        patch: ({ baseUrl }) => ({
          model_provider: "routy",
          "model_providers.routy.name": "routy",
          "model_providers.routy.base_url": baseUrl,
          "model_providers.routy.wire_api": "responses", // Codex speaks Responses
        }),
      },
    ],
  },
  {
    id: "opencode",
    name: "opencode",
    binaries: ["opencode"],
    note: "Registers routy as an OpenAI-compatible provider. Model ids can contain dots and slashes, so the provider entry is replaced as a whole rather than by key.",
    files: [
      {
        path: "~/.config/opencode/opencode.json",
        format: "jsonc",
        connectedWhen: "provider.routy.options.baseURL",
        patch: ({ baseUrl, apiKey, model, get }) => {
          const existing = get("provider.routy") ?? {};
          const models = { ...(existing.models ?? {}) };
          if (model) models[model] = { name: model, modalities: { input: ["text", "image"], output: ["text"] } };
          return {
            "provider.routy": {
              npm: "@ai-sdk/openai-compatible",
              name: "routy",
              options: { ...(existing.options ?? {}), baseURL: baseUrl, apiKey },
              models,
            },
            ...(model ? { model: `routy/${model}` } : {}),
          };
        },
      },
    ],
  },
  {
    id: "droid",
    name: "Droid",
    binaries: ["droid"],
    note: "Adds routy to Droid's custom model list. Existing entries are kept; only routy's own are replaced.",
    files: [
      {
        path: "~/.factory/settings.json",
        format: "jsonc",
        connectedCheck: ({ get }) =>
          (Array.isArray(get("customModels")) ? get("customModels") : []).some((m) => String(m?.id ?? "").startsWith("custom:routy")),
        patch: ({ baseUrl, apiKey, model, get }) => {
          // Replace only routy's own entries — the array holds the user's other
          // custom models too, and replacing it wholesale would delete them.
          const existing = Array.isArray(get("customModels")) ? get("customModels") : [];
          const others = existing.filter((m) => !String(m?.id ?? "").startsWith("custom:routy"));
          const entry = { id: `custom:routy/${model ?? "default"}`, name: "routy", baseUrl, apiKey, model };
          return { customModels: [...others, entry] };
        },
      },
    ],
  },
  {
    id: "cline",
    name: "Cline",
    binaries: ["cline"],
    note: "Cline keeps its settings and its secrets in separate files, so routy writes both. It also wants the base URL without the /v1 suffix.",
    files: [
      {
        path: "~/.cline/data/globalState.json",
        format: "jsonc",
        connectedWhen: "openAiBaseUrl",
        patch: ({ baseUrlNoV1, model }) => ({
          actModeApiProvider: "openai",
          planModeApiProvider: "openai",
          openAiBaseUrl: baseUrlNoV1,
          ...(model ? { openAiModelId: model, planModeOpenAiModelId: model } : {}),
        }),
      },
      {
        path: "~/.cline/data/secrets.json",
        format: "jsonc",
        patch: ({ apiKey }) => ({ openAiApiKey: apiKey }),
      },
    ],
  },
  {
    id: "kilo",
    name: "Kilo Code",
    binaries: ["kilo"],
    note: "Writes the extension's auth file, and its VS Code settings when that file is present.",
    files: [
      {
        path: "~/.local/share/kilo/auth.json",
        format: "jsonc",
        connectedWhen: "openai-compatible.baseUrl",
        patch: ({ baseUrl, apiKey, model }) => ({
          "openai-compatible": { type: "api-key", apiKey, baseUrl, model },
        }),
      },
      {
        path: "~/.config/Code/User/settings.json",
        format: "jsonc",
        optional: true, // only if VS Code is actually installed
        patch: ({ baseUrl, apiKey, model }) => ({
          "kilocode.customProvider": { name: "routy", baseURL: baseUrl, apiKey },
          "kilocode.defaultModel": model,
        }),
      },
    ],
  },
  {
    id: "copilot",
    name: "Copilot Chat (VS Code)",
    binaries: [],
    note: "VS Code's chat model list is a JSON array, so routy replaces its own entry and leaves the rest alone.",
    files: [
      {
        path: "~/.config/Code/User/chatLanguageModels.json",
        format: "jsonc",
        connectedCheck: ({ get }) => (Array.isArray(get(ROOT)) ? get(ROOT) : []).some((e) => e?.name === "routy"),
        patch: ({ baseUrl, apiKey, model, get }) => {
          const list = Array.isArray(get(ROOT)) ? get(ROOT) : [];
          const others = list.filter((e) => e?.name !== "routy");
          const entry = {
            name: "routy",
            vendor: "azure",
            apiKey: apiKey || "sk-routy",
            models: (model ? [model] : []).map((id) => ({
              id,
              name: id,
              url: `${baseUrl}/chat/completions#models.ai.azure.com`,
              toolCalling: true,
              vision: false,
              maxInputTokens: 128000,
              maxOutputTokens: 16000,
            })),
          };
          return { [ROOT]: [...others, entry] };
        },
      },
    ],
  },
  {
    id: "hermes",
    name: "Hermes",
    binaries: ["hermes"],
    note: "YAML config plus a .env for the key. The model block is replaced; everything else in the file is untouched.",
    files: [
      {
        path: "~/.hermes/config.yaml",
        format: "yaml",
        connectedWhen: "model.base_url",
        patch: ({ baseUrl, model }) => ({
          "model.provider": "custom",
          "model.base_url": baseUrl,
          ...(model ? { "model.default": model } : {}),
          "model.api_key": "${OPENAI_API_KEY}",
        }),
      },
      {
        path: "~/.hermes/.env",
        format: "env",
        patch: ({ apiKey }) => ({ OPENAI_API_KEY: apiKey }),
      },
    ],
  },
  {
    id: "jcode",
    name: "jcode",
    binaries: ["jcode"],
    note: "Registers a provider profile and keeps its key in a separate env file, which jcode reads at launch.",
    files: [
      {
        path: "~/.jcode/config.toml",
        format: "toml",
        connectedWhen: "providers.routy.base_url",
        patch: ({ baseUrl, model }) => ({
          "providers.routy.type": "openai-compatible",
          "providers.routy.base_url": baseUrl,
          "providers.routy.auth": "bearer",
          "providers.routy.api_key_env": "JCODE_ROUTY_API_KEY",
          "providers.routy.env_file": "provider-routy.env",
          "providers.routy.default_model": model ?? "",
          "providers.routy.requires_api_key": true,
        }),
      },
      {
        path: "~/.config/jcode/provider-routy.env",
        format: "env",
        patch: ({ apiKey }) => ({ JCODE_ROUTY_API_KEY: apiKey }),
      },
    ],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    binaries: ["grok"],
    note: "Adds a model slot rather than replacing the active one, so your existing Grok configuration keeps working.",
    files: [
      {
        path: "~/.grok/config.toml",
        format: "toml",
        connectedWhen: "model.routy.base_url",
        patch: ({ baseUrl, apiKey, model }) => ({
          "model.routy.model": model ?? "",
          "model.routy.base_url": baseUrl,
          "model.routy.name": "routy",
          "model.routy.api_key": apiKey ?? "",
          "model.routy.api_backend": "chat_completions",
        }),
      },
    ],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    binaries: ["openclaw"],
    note: "Registers routy as a provider and makes its first model the default.",
    files: [
      {
        path: "~/.openclaw/openclaw.json",
        format: "jsonc",
        connectedWhen: "models.providers.routy.baseUrl",
        patch: ({ baseUrl, apiKey, model, get }) => {
          const existing = get("models.providers.routy") ?? {};
          const models = { ...(existing.models ?? {}) };
          if (model) models[model] = { name: model };
          return {
            "models.providers.routy": { ...existing, name: "routy", baseUrl, apiKey, models },
            ...(model ? { "agents.defaults.model.primary": `routy/${model}` } : {}),
          };
        },
      },
    ],
  },
  {
    id: "deepseek-tui",
    name: "DeepSeek TUI",
    binaries: ["deepseek"],
    note: "This tool's config file holds nothing but its provider settings, so routy replaces the whole file. Disconnect restores the previous contents.",
    files: [
      {
        path: "~/.deepseek/config.toml",
        format: "toml",
        connectedCheck: ({ get }) => /provider\s*=\s*"openai"/.test(String(get(ROOT) ?? "")),
        patch: ({ baseUrl, apiKey, model }) => ({
          [ROOT]: `provider = "openai"\n\n[providers.openai]\nbase_url = "${baseUrl}"\napi_key = "${apiKey ?? ""}"\nmodel = "${model ?? ""}"\n`,
        }),
      },
    ],
  },
  {
    id: "crush",
    name: "Crush",
    binaries: ["crush"],
    note: "Registers routy as a provider in Crush's config.",
    files: [
      {
        path: "~/.config/crush/crush.json",
        format: "jsonc",
        connectedWhen: "providers.routy.base_url",
        patch: ({ baseUrl, apiKey }) => ({
          "providers.routy": { name: "routy", type: "openai", base_url: baseUrl, api_key: apiKey ?? "" },
        }),
      },
    ],
  },
  {
    id: "codewhale",
    name: "CodeWhale",
    binaries: ["codewhale"],
    note: "CodeWhale reads a single [openai] provider section, so routy writes there. Disconnect restores whatever that section held before.",
    files: [
      {
        path: "~/.codewhale/config.toml",
        format: "toml",
        connectedWhen: "openai.base_url",
        patch: ({ baseUrl, apiKey, model }) => ({
          "openai.base_url": baseUrl,
          "openai.api_key": apiKey ?? "",
          "openai.model": model ?? "",
        }),
      },
    ],
  },
  {
    id: "forge",
    name: "Forge",
    binaries: ["forge"],
    note: "Forge reads a single [openai] provider section, so routy writes there. Disconnect restores whatever that section held before.",
    files: [
      {
        path: "~/.forge/config.toml",
        format: "toml",
        connectedWhen: "openai.base_url",
        patch: ({ baseUrl, apiKey, model }) => ({
          "openai.base_url": baseUrl,
          "openai.api_key": apiKey ?? "",
          "openai.model": model ?? "",
        }),
      },
    ],
  },
  {
    id: "pi",
    name: "pi",
    binaries: ["pi"],
    note: "Registers routy as a provider in pi's model list.",
    files: [
      {
        path: "~/.pi/agent/models.json",
        format: "jsonc",
        connectedWhen: "providers.routy.baseUrl",
        patch: ({ baseUrl, apiKey }) => ({
          "providers.routy": { name: "routy", baseUrl, apiKey: apiKey ?? "" },
        }),
      },
    ],
  },
  {
    id: "smelt",
    name: "Smelt",
    binaries: ["smelt"],
    note: "Writes the gateway settings at the top level of Smelt's config.",
    files: [
      {
        path: "~/.smelt/config.json",
        format: "jsonc",
        connectedWhen: "baseUrl",
        patch: ({ baseUrl, apiKey, model }) => ({
          baseUrl,
          apiKey: apiKey ?? "",
          ...(model ? { model } : {}),
        }),
      },
    ],
  },
  {
    id: "omp",
    name: "omp",
    binaries: ["omp"],
    note: "Writes a provider block into omp's models.yml. The rest of the file, including your other providers, is left alone.",
    files: [
      {
        path: "~/.omp/agent/models.yml",
        format: "yaml",
        connectedCheck: ({ get }) => /^ {2}routy:/m.test(String(get(ROOT) ?? "")),
        // Two levels deep and replaced as a block, which dotted paths cannot express,
        // so this adapter edits the text directly. The whole file is snapshotted.
        apply: (text, { baseUrl, apiKey }) => {
          const block = [
            "  routy:",
            `    baseUrl: ${baseUrl}`,
            `    apiKey: ${apiKey ?? ""}`,
            "    api: openai-completions",
            "    authHeader: true",
            "    disableStrictTools: true",
            "    discovery:",
            "      type: proxy",
          ].join("\n");
          const withoutOurs = text.replace(/\s* {2}routy:[\s\S]*?(?=\n {2}\w+:|$)/g, "").replace(/\s+$/, "");
          return `${withoutOurs}${withoutOurs ? "\n" : ""}${block}\n`;
        },
      },
    ],
  },
  {
    id: "devin",
    name: "Devin",
    binaries: ["devin"],
    // Detection only: Devin resolves its endpoint from its own account settings, so
    // there is no local file to point at routy.
    files: [],
    note: "Detected, but Devin takes its endpoint from your account rather than a local file, so routy cannot repoint it.",
  },
];

export const findAdapter = (id) => ADAPTERS.find((a) => a.id === id) ?? null;

/**
 * Directories a binary can live in that are not on this process's PATH.
 *
 * A gateway started by systemd gets a minimal PATH — typically
 * /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin — so anything the user
 * installed under their own home is invisible to it. That is the common case for the
 * tools this screen exists for: ~/.local/bin is where pipx, uv, cargo and a dozen
 * installers put things, and it is on the user's PATH but not the service's.
 *
 * Reporting "not installed" for a tool that is installed, and that works in the user's
 * own shell, is worse than reporting nothing — it sends them looking for a problem
 * that is ours.
 */
function userBinDirs(home) {
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, "bin"),
    "/usr/local/bin",
  ];
  if (process.platform === "win32") {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Programs"));
  }
  return dirs;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Where a binary lives, if installed. PATH alone is not enough — see userBinDirs. */
export function findBinary(names, { home = os.homedir() } = {}) {
  if (!names?.length) return null;
  const isWindows = process.platform === "win32";
  const extra = userBinDirs(home).filter(isDir);
  const env = { ...process.env, PATH: [...extra, process.env.PATH || ""].join(path.delimiter) };

  for (const name of names) {
    try {
      const out = execFileSync(isWindows ? "where" : "which", [name], { env, encoding: "utf8", windowsHide: true });
      const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      if (first) return first;
    } catch {
      /* not found through which — fall through to the direct check */
    }
    // `which` is not guaranteed to exist on a minimal image, and it only knows PATH.
    // A direct executable check costs nothing and covers both.
    const suffixes = isWindows ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const dir of extra) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix);
        try {
          fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
          return candidate;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Resolve a file entry to an absolute path, honouring platform-specific dirs. */
export const resolveFile = (entry, home) => {
  if (entry.path.includes("~/.config/Code/User/")) {
    return path.join(vscodeUserDir(home), path.basename(entry.path));
  }
  return expand(entry.path, home);
};

const backupKey = (id) => `cliToolBackup:${id}`;

/** Everything the dashboard needs about one tool, with no side effects. */
export function toolStatus(repos, adapter, { home = os.homedir() } = {}) {
  const binary = findBinary(adapter.binaries, { home });
  const files = (adapter.files ?? []).map((entry) => {
    const file = resolveFile(entry, home);
    return { file, text: readText(file), entry };
  });
  const primary = files.find((f) => f.entry.connectedWhen || f.entry.connectedCheck) ?? files[0] ?? null;

  let current;
  if (primary && primary.text != null && primary.entry.connectedCheck) {
    // Some configs have no single key that means "connected" — Copilot's is a JSON
    // array, so the check has to look inside it rather than at a path.
    const get = (dotted) => getValue(primary.text, primary.entry.format, dotted);
    try {
      current = primary.entry.connectedCheck({ get }) ? true : undefined;
    } catch {
      current = undefined;
    }
  } else if (primary && primary.text != null && primary.entry.connectedWhen) {
    current = getValue(primary.text, primary.entry.format, primary.entry.connectedWhen);
  }
  const anyFile = files.some((f) => f.text != null);

  return {
    id: adapter.id,
    name: adapter.name,
    note: adapter.note ?? null,
    // A tool with no config files is detection-only; "installed" is still meaningful.
    installed: !!(binary || anyFile),
    binary: binary ?? null,
    configPath: primary ? primary.file : null,
    configExists: anyFile,
    format: primary?.entry.format ?? null,
    connected: current !== undefined && current !== null,
    baseUrl: typeof current === "string" ? current : null,
    managed: !!repos.settings.get(backupKey(adapter.id), null),
    writable: (adapter.files ?? []).length > 0,
  };
}

/**
 * Write the gateway settings for one tool.
 *
 * Every file is snapshotted before anything is written; if a later file fails the
 * earlier ones are put back, because a half-applied config is worse than none.
 */
export function connectTool(repos, id, { baseUrl, apiKey = null, model = null, home } = {}) {
  const adapter = findAdapter(id);
  if (!adapter) return { ok: false, error: "unknown_tool", detail: `no adapter for "${id}"` };
  if (!adapter.files?.length) {
    return { ok: false, error: "not_writable", detail: `${adapter.name} has no local config to write` };
  }
  if (!baseUrl) return { ok: false, error: "bad_request", detail: "baseUrl is required" };

  const ctxBase = {
    baseUrl,
    baseUrlNoV1: baseUrl.replace(/\/v1\/?$/, ""),
    apiKey,
    model,
    models: model ? [model] : [],
  };

  const planned = [];
  for (const entry of adapter.files) {
    const file = resolveFile(entry, home);
    const original = readText(file);
    if (original == null && entry.optional) continue; // VS Code not installed
    const get = (dotted) => (original == null ? undefined : getValue(original, entry.format, dotted));
    const previous = {};
    let next;
    if (entry.apply) {
      // Escape hatch for a config the dotted-path model cannot express — omp's
      // models.yml nests a provider block two levels deep and replaces it by regex.
      // The whole file is snapshotted instead, so revert is still exact.
      try {
        next = entry.apply(original ?? "", { ...ctxBase, get });
      } catch (err) {
        return { ok: false, error: "patch_failed", detail: `${adapter.name}: ${err.message}` };
      }
      previous[ROOT] = original;
      planned.push({ file, format: entry.format, original, next, previous, existed: original != null, whole: true });
      continue;
    }
    let changes;
    try {
      changes = entry.patch({ ...ctxBase, get });
    } catch (err) {
      return { ok: false, error: "patch_failed", detail: `${adapter.name}: ${err.message}` };
    }
    for (const key of Object.keys(changes)) {
      const was = original == null ? undefined : getValue(original, entry.format, key);
      previous[key] = was === undefined ? null : was;
    }
    try {
      next = setValues(original, entry.format, changes);
    } catch (err) {
      return { ok: false, error: "unparseable_config", detail: `${file}: ${err.message}` };
    }
    planned.push({ file, format: entry.format, original, next, previous, existed: original != null });
  }

  if (!planned.length) return { ok: false, error: "nothing_to_write", detail: "no writable config found" };

  const written = [];
  try {
    for (const p of planned) {
      fs.mkdirSync(path.dirname(p.file), { recursive: true });
      fs.writeFileSync(p.file, p.next);
      written.push(p);
    }
  } catch (err) {
    // roll back whatever landed, so the tool is never left half-configured
    for (const p of written) {
      if (p.existed) fs.writeFileSync(p.file, p.original);
      else fs.rmSync(p.file, { force: true });
    }
    return { ok: false, error: "write_failed", detail: err.message };
  }

  repos.settings.update({
    [backupKey(id)]: {
      at: new Date().toISOString(),
      files: planned.map((p) => ({ file: p.file, format: p.format, existed: p.existed, original: p.original, previous: p.previous })),
    },
  });
  return { ok: true, id, files: planned.map((p) => p.file) };
}

/**
 * Put back exactly what connect wrote.
 *
 * A path that did not exist before is removed; one that held a value gets it back.
 * A file that did not exist is removed rather than left as a stub.
 */
export function disconnectTool(repos, id) {
  const adapter = findAdapter(id);
  if (!adapter) return { ok: false, error: "unknown_tool", detail: `no adapter for "${id}"` };
  const backup = repos.settings.get(backupKey(id), null);
  if (!backup) return { ok: false, error: "not_connected_by_routy", detail: "nothing was written by routy for this tool" };

  const restored = [];
  for (const record of backup.files ?? []) {
    const current = readText(record.file);
    if (!record.existed) {
      fs.rmSync(record.file, { force: true }); // we created it; remove it again
      restored.push(record.file);
      continue;
    }
    if (current == null) continue; // already gone
    // A custom apply() snapshots the whole file, so revert is a straight restore.
    if (record.whole) {
      fs.writeFileSync(record.file, record.previous?.[ROOT] ?? current);
      restored.push(record.file);
      continue;
    }
    const restore = {};
    const remove = [];
    for (const [key, value] of Object.entries(record.previous ?? {})) {
      if (value === null || value === undefined) remove.push(key);
      else restore[key] = value;
    }
    let next = current;
    try {
      if (remove.length) next = deleteValues(next, record.format, remove);
      if (Object.keys(restore).length) next = setValues(next, record.format, restore);
    } catch (err) {
      return { ok: false, error: "unparseable_config", detail: `${record.file}: ${err.message}` };
    }
    fs.writeFileSync(record.file, next);
    restored.push(record.file);
  }

  repos.settings.update({ [backupKey(id)]: null });
  return { ok: true, id, restored };
}

export const allStatuses = (repos, opts) => ADAPTERS.map((a) => toolStatus(repos, a, opts));
