# CLI Tools

Point an AI CLI installed on the same machine at routy, from the dashboard. routy
finds the tool, writes the two or three settings that decide its endpoint, and can
put the file back exactly as it found it.

**Settings → CLI Tools**, or `/cli-tools`.

## How detection works

Two signals, either of which is enough:

1. **The binary.** `where <name>` on Windows, `which <name>` elsewhere — with
   `%APPDATA%\npm` prepended to `PATH`, because npm global bins are not on it by
   default and that is where most of these tools install.
2. **The config file.** If the binary lookup fails but the config exists, the tool is
   still reported as installed — it usually means the binary is somewhere `PATH`
   cannot see.

A tool that is neither is hidden from the page.

## What connecting writes

Every adapter is a list of files and the dotted paths to write in each:

| Tool | Config | Writes |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, the three model slots, `hasCompletedOnboarding` |
| Codex CLI | `~/.codex/config.toml` | `model_provider`, `[model_providers.routy]` with `base_url` + `wire_api = "responses"` |
| opencode | `~/.config/opencode/opencode.json` | `provider.routy` (options + models), `model` |
| Droid | `~/.factory/settings.json` | an entry in `customModels` |
| Cline | `~/.cline/data/globalState.json` + `secrets.json` | provider + base URL + model; key in the secrets file |
| Kilo Code | `~/.local/share/kilo/auth.json` (+ VS Code settings if present) | `openai-compatible` entry |
| Copilot Chat | `%APPDATA%/Code/User/chatLanguageModels.json` | routy's entry in the JSON array |
| Hermes | `~/.hermes/config.yaml` + `.env` | the `model:` block; key in `.env` |
| jcode | `~/.jcode/config.toml` + `~/.config/jcode/provider-routy.env` | a provider profile; key in the env file |
| Grok Build | `~/.grok/config.toml` | a `[model.routy]` slot, leaving your active model alone |
| OpenClaw | `~/.openclaw/openclaw.json` | provider entry + default agent model |
| DeepSeek TUI | `~/.deepseek/config.toml` | the whole file (it holds nothing else) |
| Devin | — | detected only; it takes its endpoint from your account |

## Undoing it

Connect snapshots every path it is about to touch — the value, or "this key was not
there". **Disconnect** restores exactly those:

- a key that existed gets its old value back
- a key that did not exist is removed, along with any now-empty parent object
- a file routy created is deleted again rather than left as a stub

Anything else you have changed in that file in the meantime is left alone.

The revert is tested to be **byte-identical** for every adapter, against fixtures that
include comments, other providers and unrelated settings.

## Formats

routy has no runtime dependencies, so configs are edited as text where a parser
would be needed:

- **json / jsonc** — Claude's settings are hand-edited and routinely carry trailing
  commas, so they are parsed leniently
- **toml** — targeted line edits. A parse-and-reserialise round trip (what most tools
  do) deletes every comment in the file
- **yaml** — targeted block edit for the `model:` block
- **env** — `KEY=value` lines, for tools that keep the credential separately

## Notes

- **Nothing is written until you press Connect.** Detection only reads.
- The mutating endpoints require the `x-routy-action` header and reject a
  cross-origin `Origin`, so a web page you happen to have open cannot rewrite your
  CLI configs by POSTing to loopback.
- Devin is detection-only: it resolves its endpoint from your account, so there is no
  local file to point at routy.
