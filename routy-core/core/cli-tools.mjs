// CLI tools — point a locally installed AI CLI at this gateway, from the dashboard.
//
// An adapter says three things: how to notice the tool, which file holds its
// gateway settings, and what to write. Everything else — backup, exact revert,
// detection, path expansion — is shared, so adding a tool is data, not code.
//
// The revert is the part that matters. Writing into someone's Claude or Codex
// config is a real edit to a file they own, so before the first write every path we
// are about to touch is snapshotted (value, or "was absent"), and disconnecting puts
// exactly those back. Unrelated keys are never read, rewritten or removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deleteValues, getValue, setValues } from "../lib/formats.mjs";

/**
 * Home-relative paths in the table are expanded at use, never at import.
 *  is injectable so tests can drive the whole flow against a temp directory
 * instead of the real one — the alternative is tests that edit the developer's
 * actual Claude config.
 */
const expand = (p, home = os.homedir()) => (p.startsWith("~") ? path.join(home, p.slice(1)) : p);

/**
 * The adapter table.
 *
 * `patch` returns the dotted paths to write. Values are the gateway's own: baseUrl
 * always ends in /v1, model is a routy id of the form `<prefix>/<model>`.
 */
export const ADAPTERS = [
  {
    id: "claude",
    name: "Claude Code",
    binaries: ["claude"],
    config: "~/.claude/settings.json",
    // Claude Code's settings are hand-edited and routinely carry trailing commas;
    // parsing them as strict JSON would refuse a file the tool itself accepts.
    format: "jsonc",
    // Presence of this path means the tool is already pointed at a gateway.
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
      // Without this Claude Code shows its onboarding flow on next launch.
      hasCompletedOnboarding: true,
    }),
    note: "Claude Code reads ANTHROPIC_AUTH_TOKEN, so it sends `Authorization: Bearer`. If you set ANTHROPIC_API_KEY instead it sends `x-api-key`, which routy also accepts.",
  },
  {
    id: "codex",
    name: "Codex CLI",
    binaries: ["codex"],
    config: "~/.codex/config.toml",
    format: "toml",
    connectedWhen: "model_providers.routy.base_url",
    patch: ({ baseUrl }) => ({
      model_provider: "routy",
      "model_providers.routy.name": "routy",
      "model_providers.routy.base_url": baseUrl,
      // Codex speaks the Responses API; routy serves /v1/responses.
      "model_providers.routy.wire_api": "responses",
    }),
    note: "Edited as text, so comments and your other providers survive. Codex keeps its own credential in ~/.codex/auth.json, which routy does not touch.",
  },
];

export const findAdapter = (id) => ADAPTERS.find((a) => a.id === id) ?? null;

/** Where a binary lives, if it is installed. npm global bins are not on PATH by default. */
export function findBinary(names) {
  const isWindows = process.platform === "win32";
  const extra = isWindows && process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null;
  const env = extra ? { ...process.env, PATH: `${extra}${path.delimiter}${process.env.PATH}` } : process.env;
  for (const name of names) {
    try {
      const out = execFileSync(isWindows ? "where" : "which", [name], { env, encoding: "utf8", windowsHide: true });
      const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      if (first) return first;
    } catch {
      /* not on PATH — try the next name */
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

/** Everything the dashboard needs about one tool, with no side effects. */
export function toolStatus(repos, adapter, { home } = {}) {
  const configPath = expand(adapter.config, home);
  const binary = findBinary(adapter.binaries);
  const text = readText(configPath);
  const current = text == null ? undefined : getValue(text, adapter.format, adapter.connectedWhen);
  const backup = repos.settings.get(backupKey(adapter.id), null);
  return {
    id: adapter.id,
    name: adapter.name,
    note: adapter.note ?? null,
    installed: !!(binary || text != null),
    binary: binary ?? null,
    configPath,
    configExists: text != null,
    format: adapter.format,
    // "connected" means it points at *some* gateway; the URL says whether it is us.
    connected: current !== undefined && current !== null,
    baseUrl: typeof current === "string" ? current : null,
    managed: !!backup,
  };
}

const backupKey = (id) => `cliToolBackup:${id}`;

/**
 * Write the gateway settings for one tool.
 *
 * Snapshots every path first. If a write fails the file is left as it was found —
 * a half-applied config is worse than none.
 */
export function connectTool(repos, id, { baseUrl, apiKey, model = null, home } = {}) {
  const adapter = findAdapter(id);
  if (!adapter) return { ok: false, error: "unknown_tool", detail: `no adapter for "${id}"` };
  if (!baseUrl) return { ok: false, error: "bad_request", detail: "baseUrl is required" };

  const configPath = expand(adapter.config, home);
  const original = readText(configPath);
  const changes = adapter.patch({ baseUrl, apiKey, model });

  // Snapshot before writing, so disconnect restores what was actually there.
  const previous = {};
  for (const key of Object.keys(changes)) {
    const was = original == null ? undefined : getValue(original, adapter.format, key);
    previous[key] = was === undefined ? null : was;
  }

  let next;
  try {
    next = setValues(original, adapter.format, changes);
  } catch (err) {
    return { ok: false, error: "unparseable_config", detail: `${adapter.config}: ${err.message}` };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next);
  repos.settings.update({
    [backupKey(id)]: { file: configPath, existed: original != null, previous, at: new Date().toISOString() },
  });
  return { ok: true, id, configPath, wrote: Object.keys(changes) };
}

/**
 * Put back exactly the paths connect wrote.
 *
 * A path that did not exist before is removed; one that held a value gets it back.
 * If the file itself did not exist, it is removed again rather than left as a stub.
 */
export function disconnectTool(repos, id) {
  const adapter = findAdapter(id);
  if (!adapter) return { ok: false, error: "unknown_tool", detail: `no adapter for "${id}"` };
  const backup = repos.settings.get(backupKey(id), null);
  if (!backup) return { ok: false, error: "not_connected_by_routy", detail: "nothing was written by routy for this tool" };

  const current = readText(backup.file);
  if (current == null) {
    repos.settings.update({ [backupKey(id)]: null });
    return { ok: true, id, note: "config file was already gone" };
  }

  // Split the snapshot into paths to restore and paths to remove.
  const restore = {};
  const remove = [];
  for (const [key, value] of Object.entries(backup.previous ?? {})) {
    if (value === null || value === undefined) remove.push(key);
    else restore[key] = value;
  }

  let next = current;
  try {
    if (remove.length) next = deleteValues(next, adapter.format, remove);
    if (Object.keys(restore).length) next = setValues(next, adapter.format, restore);
  } catch (err) {
    return { ok: false, error: "unparseable_config", detail: err.message };
  }

  if (!backup.existed) {
    fs.rmSync(backup.file, { force: true });
  } else {
    fs.writeFileSync(backup.file, next);
  }
  repos.settings.update({ [backupKey(id)]: null });
  return { ok: true, id, restored: Object.keys(restore), removed: remove };
}

/** Every adapter, with status. */
export const allStatuses = (repos, opts) => ADAPTERS.map((a) => toolStatus(repos, a, opts));
