import { readFileSync, writeFileSync, readdirSync } from "fs";
import path from "path";

const providers = JSON.parse(readFileSync("rigs/providers.json", "utf8"));

// --- executor LOC ---
const execDir = path.join("9router", "open-sse", "executors");
const execFiles = readdirSync(execDir).filter(f => f.endsWith(".js") && !["base.js", "index.js", "default.js"].includes(f));
const execLoc = {};
for (const f of execFiles) {
  execLoc[f.replace(".js", "")] = readFileSync(path.join(execDir, f), "utf8").split("\n").length;
}

const bt = (s) => s ? `\`${s}\`` : "—";
function providerRow(p) {
  const notes = [];
  if (p.executor !== "default") notes.push(`executor: ${p.executor}`);
  if (p.passthroughModels) notes.push("passthrough-models");
  if (p.forceStream) notes.push("force-stream");
  if (p.deprecated) notes.push("display-flag: deprecated");
  if (p.quirks.length) notes.push(`quirks: ${p.quirks.join("/")}`);
  if (p.urlSuffix) notes.push(`urlSuffix ${p.urlSuffix}`);
  return `| ${bt(p.id)} | ${p.name} | ${bt(p.format)} | ${bt(p.authType)} | ${p.baseUrl ? bt(p.baseUrl.length > 60 ? p.baseUrl.slice(0, 57) + "..." : p.baseUrl) : "—"} | ${notes.join(", ") || "—"} |`;
}

function table(ps, title) {
  if (!ps.length) return "";
  return `### ${title} (${ps.length})\n\n| id | name | format | auth | baseUrl | notes |\n|---|---|---|---|---|---|\n${ps.map(providerRow).join("\n")}\n`;
}

const byCat = (c) => providers.filter(p => p.category === c).sort((a, b) => a.id.localeCompare(b.id));
const fmtCount = {};
for (const p of providers) fmtCount[p.format] = (fmtCount[p.format] || 0) + 1;

const oauthRegistry = ["cline", "clinepass", "codebuddy-cn", "codebuddy-intl", "grok-cli", "kimchi", "kimi", "qoder", "trae", "windsurf", "xai", "xiaomi-mimo", "zed"];
const oauthServer = ["antigravity", "claude", "codex", "cursor", "github", "gitlab", "iflow", "kilocode"];

const md = `# RE-E Provider Catalog

> **Purpose:** complete inventory of 9Router's 122 provider registry entries with the
> information needed to implement any of them later in RE-E. Generated from
> \`9router/open-sse/providers/registry/*.js\` on 2026-09-17 (upstream v0.5.75).
> Scope decision: **RE-E v1 ships zero embedded providers — only custom OpenAI-compatible
> nodes** (user-provided baseUrl + apiKey). This catalog is the implementation menu for
> everything beyond v1.
>
> Regenerate after upstream updates: \`node rigs/extract-providers.mjs\` then re-run the
> render step (or ask the assistant — raw data persists in \`rigs/providers.json\`).

---

## 1. How 9Router defines a provider

One file per provider in \`open-sse/providers/registry/{id}.js\`, exporting a
\`RegistryEntry\` (contract: \`open-sse/providers/schema.js:8-39\`). Fields that matter:

| Field | Meaning |
|---|---|
| \`id\` / \`alias\` / \`aliases\` | routing key — \`alias/model\` in requests resolves through these |
| \`category\` | apikey \\| oauth \\| freeTier \\| free \\| webCookie — drives UI grouping + auth assumptions |
| \`transport.baseUrl\` | upstream endpoint (chat path appended per format) |
| \`transport.format\` | wire format → selects translator chain + endpoint defaults |
| \`transport.headers\` | extra static headers (e.g. \`anthropic-version\`) |
| \`transport.auth\` | header name / scheme / credential source (accessToken vs apiKey) |
| \`transport.executor\` | override hint (in practice ALL registry entries say "default" — real executor wiring is \`open-sse/executors/index.js\` keyed by provider id) |
| \`oauth\` | OAuthConfig: clientId, authorizeUrl, tokenUrl, deviceCodeUrl, refreshUrl, scopes, redirectUri, refreshLeadMs |
| \`models[]\` | static model list (\`{id, name}\`); some providers fetch dynamically instead |
| \`features.usage\` | provider exposes a usage/quota endpoint |
| \`passthroughModels\` | forward client model id untouched |

Endpoint defaults per format (\`schema.js:59-63\`): openai → \`/chat/completions\` + \`/models\`;
claude → \`/messages\` + \`/models\` + \`/messages/count_tokens\`; gemini → \`/{model}:streamGenerateContent\`.

**Key architectural fact:** the registry is *declarative*; behavior comes from three
separate layers — (1) translator pair (format-driven), (2) executor instance
(\`executors/index.js\` provider-id map), (3) token refresh function
(\`tokenRefresh/providers.js\`). Implementing a provider later = filling 1-3 of these layers.

## 2. RE-E v1: custom OpenAI-compatible node only

Zero embedded providers. v1 ports the **provider node** concept
(\`src/lib/db/repos/nodesRepo.js\`): a dynamic, user-created upstream:

\`\`\`
{ id, type, name, prefix, apiType, baseUrl, ... }   // apiType: "openai" | "anthropic"
\`\`\`

Plus an API key stored as a connection. What v1 must implement:
1. Model string \`{prefix}/{model}\` → route to node's baseUrl
2. Auth header injection (Bearer, or x-api-key for anthropic apiType)
3. openai→openai (or claude→claude) = **passthrough**, no translation
4. \`GET /models\` fetch for model listing (openai nodes)
5. Retry/fallback/retry-config from the default executor (keep upstream's design)

This one mechanism already covers: OpenRouter, Groq, Together, DeepSeek, GLM, Kimi,
MiniMax, Mistral, xAI, Cerebras, SiliconFlow, Nebius, Fireworks, any Ollama/LM Studio/
vLLM/llama.cpp server, any self-hosted vLLM — i.e. **most of section 4.1 below works on
day one for free** by just creating a node. Embedded providers only become necessary for
OAuth flows and format specialties.

## 3. Wire formats across the catalog

| format | providers | chat endpoint | note |
|---|---|---|---|
${Object.entries(fmtCount).sort((a, b) => b[1] - a[1]).map(([f, n]) => {
  const ep = { openai: "/chat/completions", claude: "/messages", "openai-responses": "/responses", cursor: "protobuf over HTTP", kiro: "ConversationState JSON", antigravity: "Gemini v1internal", "gemini-cli": "generateContent", gemini: "generateContent", vertex: "generateContent", ollama: "/api/chat", commandcode: "proprietary", "grok-web": "scraped web", "perplexity-web": "scraped web" }[f] || "?";
  return `| ${bt(f)} | ${n} | ${bt(ep)} | ${["cursor","kiro","grok-web","perplexity-web","commandcode","antigravity"].includes(f) ? "custom executor required" : "default executor"} |`;
}).join("\n")}

## 4. Catalog by category

${table(byCat("apikey"), "4.1 API-key providers")}

${table(byCat("oauth"), "4.2 OAuth providers")}

**OAuth mechanism split** — where the implementation lives upstream:
- **Registry-declared flow** (generic device-code/authorize handler works): ${oauthRegistry.join(", ")}
- **Server-side bespoke flow** (hand-written in \`src/lib/oauth/\` + \`src/app/api/oauth/\`): ${oauthServer.join(", ")}

${table(byCat("freeTier"), "4.3 Free tier")}
${table(byCat("free"), "4.4 Free (no auth)")}
${table(byCat("webCookie"), "4.5 Web-cookie (browser session hijack style)")}

Media providers (TTS/STT/image/video/search) are configured separately in
\`open-sse/config/mediaConfig.js\` — out of RE-E v1 scope (deferred), cataloged on request.

## 5. Custom executors (the expensive list)

Default executor = generic POST + retry + fallback (~185 LOC). Anything below needs bespoke
code to port later. LOC = upstream file size, proxy for complexity.

| provider | executor file | LOC | why custom |
|---|---|---|---|
${Object.entries(execLoc).sort((a, b) => b[1] - a[1]).map(([p, loc]) => {
  const why = {
    kiro: "ConversationState format, SigV4-style auth, session replay",
    cursor: "protobuf body + checksum headers",
    codex: "Responses API + ChatGPT OAuth",
    "devin-cli": "proprietary devin protocol",
    qoder: "custom envelope + encoding + context tiers",
    antigravity: "Gemini-family + quota/strike semantics",
    windsurf: "RegisterUser/Firebase auth lifecycle",
    trae: "AWS SigV4 signing",
    "gemini-cli": "Google OAuth + project IDs + SSE dialect",
    github: "Copilot device flow + editor headers",
    "grok-cli": "Responses variant + reasoning effort rules",
    "grok-web": "web scraping",
    iflow: "cookie-based SSO",
    kimchi: "Kimi-variant headers",
    "mimo-free": "Xiaomi free-tier account cycling",
    "ollama-local": "local format quirks",
    "opencode-go": "per-model endpoint support matrix",
    opencode: "free-tier routing",
    "perplexity-web": "web scraping",
    vertex: "GCP auth + regions",
    azure: "deployment-key URLs",
    "codebuddy-cn": "cn/intl split",
    "codebuddy-intl": "cn/intl split",
    commandcode: "proprietary format",
    "xiaomi-mimo": "Xiaomi auth",
    "xiaomi-tokenplan": "Xiaomi token plan",
    zed: "Zed auth",
  }[p] || "";
  return `| ${bt(p)} | ${bt("open-sse/executors/" + p + ".js")} | ${loc} | ${why} |`;
}).join("\n")}

## 6. Token refresh inventory (for future OAuth work)

\`open-sse/services/tokenRefresh/providers.js\` (707 LOC) implements per-provider refresh:
\`refreshAccessToken(provider, ...)\` generic profile-driven refresh + bespoke:
xai, kimi, cline, claude, google, codex, kiro, iflow, github, copilot, codebuddy-cn,
codebuddy-intl, trae, zed(null), windsurf(skip). All wrapped in \`dedupRefresh()\`
(\`tokenRefresh/dedup.js\`) to prevent stampedes. Background scheduler:
\`src/sse/services/backgroundTokenRefresh.js\`.

## 7. Future onboarding checklist (per class)

| Class | Effort | What you need | Upstream references |
|---|---|---|---|
| OpenAI-compatible node | ~0 (v1 covers) | baseUrl + key | nodesRepo.js, default executor |
| Anthropic-compatible node | ~0 (v1 covers) | baseUrl + key | same, apiType="anthropic" |
| API-key embedded provider (non-openai format) | Low | baseUrl, format, headers, models | registry/anthropic.js as template |
| API-key + quirks | Medium | quirks map fields | registry/{glm,minimax,grok-cli}.js |
| OAuth (registry-declared) | Medium | OAuthConfig fields; generic handler | registry/zed.js, oauth/[provider]/[action] route |
| OAuth (bespoke) | High | device/authorize flow impl | src/lib/oauth/*, api/oauth/{claude,codex,cursor,...} routes |
| Token refresh | Medium | refresh endpoint contract | tokenRefresh/providers.js |
| Custom executor | High | protocol impl | executors/{kiro,cursor,codex,...}.js |

## 8. Caveats

- \`display.deprecated\` flag is set on antigravity, claude, codex, gemini-cli, github, kiro —
  in context this marks deprecated *connect modes* (legacy import paths), not the providers.
- Free/freeTier auth types are informational; several "apikey" free-tier providers work
  with throwaway keys.
- Registry \`transport.executor\` is uniformly "default"; do not trust it for porting
  decisions — use section 5 (executors/index.js wiring) instead.
`;

writeFileSync("docs/provider-catalog.md", md);
console.log(`written docs/provider-catalog.md (${md.length} bytes), providers: ${providers.length}, executors: ${Object.keys(execLoc).length}`);
