# routy Provider Catalog

> **Purpose:** complete inventory of 9Router's 122 provider registry entries with the
> information needed to implement any of them later in routy. Generated from
> `9router/open-sse/providers/registry/*.js` on 2026-09-17 (upstream v0.5.75).
> Scope decision: **routy v1 ships zero embedded providers — only custom OpenAI-compatible
> nodes** (user-provided baseUrl + apiKey). This catalog is the implementation menu for
> everything beyond v1.
>
> Regenerate after upstream updates: `node scratch/extract-providers.mjs` then re-run the
> render step (or ask the assistant — raw data persists in `scratch/providers.json`).

---

## 1. How 9Router defines a provider

One file per provider in `open-sse/providers/registry/{id}.js`, exporting a
`RegistryEntry` (contract: `open-sse/providers/schema.js:8-39`). Fields that matter:

| Field | Meaning |
|---|---|
| `id` / `alias` / `aliases` | routing key — `alias/model` in requests resolves through these |
| `category` | apikey \| oauth \| freeTier \| free \| webCookie — drives UI grouping + auth assumptions |
| `transport.baseUrl` | upstream endpoint (chat path appended per format) |
| `transport.format` | wire format → selects translator chain + endpoint defaults |
| `transport.headers` | extra static headers (e.g. `anthropic-version`) |
| `transport.auth` | header name / scheme / credential source (accessToken vs apiKey) |
| `transport.executor` | override hint (in practice ALL registry entries say "default" — real executor wiring is `open-sse/executors/index.js` keyed by provider id) |
| `oauth` | OAuthConfig: clientId, authorizeUrl, tokenUrl, deviceCodeUrl, refreshUrl, scopes, redirectUri, refreshLeadMs |
| `models[]` | static model list (`{id, name}`); some providers fetch dynamically instead |
| `features.usage` | provider exposes a usage/quota endpoint |
| `passthroughModels` | forward client model id untouched |

Endpoint defaults per format (`schema.js:59-63`): openai → `/chat/completions` + `/models`;
claude → `/messages` + `/models` + `/messages/count_tokens`; gemini → `/{model}:streamGenerateContent`.

**Key architectural fact:** the registry is *declarative*; behavior comes from three
separate layers — (1) translator pair (format-driven), (2) executor instance
(`executors/index.js` provider-id map), (3) token refresh function
(`tokenRefresh/providers.js`). Implementing a provider later = filling 1-3 of these layers.

## 2. routy v1: custom OpenAI-compatible node only

Zero embedded providers. v1 ports the **provider node** concept
(`src/lib/db/repos/nodesRepo.js`): a dynamic, user-created upstream:

```
{ id, type, name, prefix, apiType, baseUrl, ... }   // apiType: "openai" | "anthropic"
```

Plus an API key stored as a connection. What v1 must implement:
1. Model string `{prefix}/{model}` → route to node's baseUrl
2. Auth header injection (Bearer, or x-api-key for anthropic apiType)
3. openai→openai (or claude→claude) = **passthrough**, no translation
4. `GET /models` fetch for model listing (openai nodes)
5. Retry/fallback/retry-config from the default executor (keep upstream's design)

This one mechanism already covers: OpenRouter, Groq, Together, DeepSeek, GLM, Kimi,
MiniMax, Mistral, xAI, Cerebras, SiliconFlow, Nebius, Fireworks, any Ollama/LM Studio/
vLLM/llama.cpp server, any self-hosted vLLM — i.e. **most of section 4.1 below works on
day one for free** by just creating a node. Embedded providers only become necessary for
OAuth flows and format specialties.

## 3. Wire formats across the catalog

| format | providers | chat endpoint | note |
|---|---|---|---|
| `openai` | 102 | `/chat/completions` | default executor |
| `claude` | 6 | `/messages` | default executor |
| `openai-responses` | 3 | `/responses` | default executor |
| `ollama` | 2 | `/api/chat` | default executor |
| `antigravity` | 1 | `Gemini v1internal` | custom executor required |
| `commandcode` | 1 | `proprietary` | custom executor required |
| `cursor` | 1 | `protobuf over HTTP` | custom executor required |
| `gemini-cli` | 1 | `generateContent` | default executor |
| `gemini` | 1 | `generateContent` | default executor |
| `grok-web` | 1 | `scraped web` | custom executor required |
| `kiro` | 1 | `ConversationState JSON` | custom executor required |
| `perplexity-web` | 1 | `scraped web` | custom executor required |
| `vertex` | 1 | `generateContent` | default executor |

## 4. Catalog by category

### 4.1 API-key providers (77)

| id | name | format | auth | baseUrl | notes |
|---|---|---|---|---|---|
| `alicode` | Alibaba | `openai` | `apikey` | `https://coding.dashscope.aliyuncs.com/v1/chat/completions` | quirks: preserveCacheControl |
| `alicode-intl` | Alibaba Coding | `openai` | `apikey` | `https://coding-intl.dashscope.aliyuncs.com/v1/chat/comple...` | quirks: preserveCacheControl |
| `alims-intl` | Alibaba Studio | `openai` | `apikey` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/ch...` | quirks: preserveCacheControl |
| `alitp-intl` | Alibaba Token Plan | `openai` | `apikey` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compa...` | quirks: preserveCacheControl |
| `anthropic` | Anthropic | `claude` | `apikey` | `https://api.anthropic.com/v1/messages` | — |
| `assemblyai` | AssemblyAI | `openai` | `apikey` | `https://api.assemblyai.com/v1/audio/transcriptions` | — |
| `aws-polly` | AWS Polly | `openai` | `apikey` | — | — |
| `azure` | Azure OpenAI | `openai` | `apikey` | — | — |
| `baidu` | Baidu Qianfan | `openai` | `apikey` | `https://qianfan.baidubce.com/v2/chat/completions` | — |
| `black-forest-labs` | Black Forest Labs | `openai` | `apikey` | — | — |
| `blackbox` | Blackbox AI | `openai` | `apikey` | `https://api.blackbox.ai/v1/chat/completions` | — |
| `bluesminds` | BluesMinds | `openai` | `apikey` | `https://api.bluesminds.com/v1/chat/completions` | — |
| `brave-search` | Brave Search | `openai` | `apikey` | — | — |
| `cartesia` | Cartesia | `openai` | `apikey` | — | — |
| `cerebras` | Cerebras | `openai` | `apikey` | `https://api.cerebras.ai/v1/chat/completions` | quirks: dropClientMetadata |
| `chutes` | Chutes AI | `openai` | `apikey` | `https://llm.chutes.ai/v1/chat/completions` | — |
| `cohere` | Cohere | `openai` | `apikey` | `https://api.cohere.ai/v1/chat/completions` | — |
| `comfyui` | ComfyUI | `openai` | `apikey` | — | — |
| `commandcode` | Command Code | `commandcode` | `apikey` | `https://api.commandcode.ai/alpha/generate` | force-stream |
| `deepgram` | Deepgram | `openai` | `apikey` | `https://api.deepgram.com/v1/listen` | — |
| `deepseek` | DeepSeek | `openai` | `apikey` | `https://api.deepseek.com/chat/completions` | quirks: claudeSupportedToolTypes |
| `elevenlabs` | ElevenLabs | `openai` | `apikey` | — | — |
| `exa` | Exa | `openai` | `apikey` | — | — |
| `fal-ai` | Fal.ai | `openai` | `apikey` | — | — |
| `featherless` | Featherless | `openai` | `apikey` | `https://api.featherless.ai/v1/chat/completions` | — |
| `firecrawl` | Firecrawl | `openai` | `apikey` | — | — |
| `fireworks` | Fireworks AI | `openai` | `apikey` | `https://api.fireworks.ai/inference/v1/chat/completions` | — |
| `fish-audio` | Fish Audio | `openai` | `apikey` | — | — |
| `glm` | GLM Coding | `claude` | `apikey` | `https://api.z.ai/api/anthropic/v1/messages` | urlSuffix ?beta=true |
| `glm-cn` | GLM (China) | `openai` | `apikey` | `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` | — |
| `google-pse` | Google PSE | `openai` | `apikey` | — | — |
| `groq` | Groq | `openai` | `apikey` | `https://api.groq.com/openai/v1/chat/completions` | — |
| `huggingface` | HuggingFace | `openai` | `apikey` | — | — |
| `hyperbolic` | Hyperbolic | `openai` | `apikey` | `https://api.hyperbolic.xyz/v1/chat/completions` | — |
| `inworld` | Inworld TTS | `openai` | `apikey` | — | — |
| `jina-ai` | Jina AI | `openai` | `apikey` | — | — |
| `jina-reader` | Jina Reader | `openai` | `apikey` | — | — |
| `linkup` | Linkup | `openai` | `apikey` | — | — |
| `llm7` | LLM7 | `openai` | `apikey` | `https://api.llm7.io/v1/chat/completions` | passthrough-models |
| `minimax` | Minimax Coding | `claude` | `apikey` | `https://api.minimax.io/anthropic/v1/messages` | quirks: dropOutputConfig/requireClaudeToolType, urlSuffix ?beta=true |
| `minimax-cn` | Minimax (China) | `claude` | `apikey` | `https://api.minimaxi.com/anthropic/v1/messages` | quirks: dropOutputConfig/requireClaudeToolType, urlSuffix ?beta=true |
| `mistral` | Mistral | `openai` | `apikey` | `https://api.mistral.ai/v1/chat/completions` | quirks: dropClientMetadata |
| `mmf` | MMF | `openai` | `apikey` | `https://api.xiaomimimo.com/api/free-ai/openai/chat` | — |
| `morph` | Morph | `openai` | `apikey` | `https://api.morphllm.com/v1/chat/completions` | — |
| `nanobanana` | NanoBanana API | `openai` | `apikey` | `https://api.nanobananaapi.ai/v1/chat/completions` | — |
| `nebius` | Nebius AI | `openai` | `apikey` | `https://api.studio.nebius.ai/v1/chat/completions` | — |
| `ollama-local` | Ollama Local | `ollama` | `apikey` | `http://localhost:11434/api/chat` | — |
| `ollama-search` | Ollama Search | `openai` | `apikey` | — | — |
| `openai` | OpenAI | `openai` | `apikey` | `https://api.openai.com/v1/chat/completions` | force-stream |
| `opencode-go` | OpenCode Go | `openai` | `apikey` | `https://opencode.ai/zen/go/v1/chat/completions` | — |
| `perplexity` | Perplexity | `openai` | `apikey` | `https://api.perplexity.ai/chat/completions` | — |
| `perplexity-agent` | Perplexity Agent | `openai-responses` | `apikey` | `https://api.perplexity.ai/v1/responses` | passthrough-models |
| `playht` | PlayHT | `openai` | `apikey` | — | — |
| `recraft` | Recraft | `openai` | `apikey` | — | — |
| `runwayml` | Runway ML | `openai` | `apikey` | — | — |
| `sambanova` | SambaNova | `openai` | `apikey` | `https://api.sambanova.ai/v1/chat/completions` | — |
| `sdwebui` | SD WebUI | `openai` | `apikey` | — | — |
| `searchapi` | SearchAPI | `openai` | `apikey` | — | — |
| `selfhosted-embedding` | Self-hosted Embedding | `openai` | `apikey` | — | — |
| `selfhosted-stt` | Self-hosted STT | `openai` | `apikey` | — | — |
| `selfhosted-tts` | Self-hosted TTS | `openai` | `apikey` | — | — |
| `serper` | Serper | `openai` | `apikey` | — | — |
| `siliconflow` | SiliconFlow | `openai` | `apikey` | `https://api.siliconflow.com/v1/chat/completions` | — |
| `stability-ai` | Stability AI | `openai` | `apikey` | — | — |
| `tavily` | Tavily | `openai` | `apikey` | — | — |
| `tencent` | Tencent Hunyuan | `openai` | `apikey` | `https://api.hunyuan.cloud.tencent.com/v1/chat/completions` | — |
| `together` | Together AI | `openai` | `apikey` | `https://api.together.xyz/v1/chat/completions` | — |
| `tokenrouter` | TokenRouter | `openai` | `apikey` | `https://api.tokenrouter.com/v1/chat/completions` | passthrough-models |
| `topaz` | Topaz | `openai` | `apikey` | — | — |
| `venice` | Venice AI | `openai` | `apikey` | `https://api.venice.ai/api/v1/chat/completions` | passthrough-models |
| `vercel-ai-gateway` | Vercel AI Gateway | `openai` | `apikey` | `https://ai-gateway.vercel.sh/v1/chat/completions` | passthrough-models |
| `vertex-partner` | Vertex Partner | `openai` | `apikey` | `https://aiplatform.googleapis.com` | — |
| `volcengine-ark` | Volcengine Ark | `openai` | `apikey` | `https://ark.cn-beijing.volces.com/api/coding/v3/chat/comp...` | — |
| `voyage-ai` | Voyage AI | `openai` | `apikey` | — | — |
| `xiaomi-tokenplan` | Xiaomi MiMo (Token Plan) | `openai` | `apikey` | `https://token-plan-sgp.xiaomimimo.com/v1/chat/completions` | — |
| `xquik` | Xquik | `openai` | `apikey` | — | — |
| `youcom` | You.com Search | `openai` | `apikey` | — | — |


### 4.2 OAuth providers (20)

| id | name | format | auth | baseUrl | notes |
|---|---|---|---|---|---|
| `antigravity` | Antigravity | `antigravity` | `apikey` | — | display-flag: deprecated |
| `claude` | Claude Code | `claude` | `apikey` | `https://api.anthropic.com/v1/messages` | display-flag: deprecated, quirks: cloakToolsOnOAuth, urlSuffix ?beta=true |
| `cline` | Cline | `openai` | `oauth` | `https://api.cline.bot/api/v1/chat/completions` | quirks: clineEnvelope |
| `clinepass` | ClinePass | `openai` | `oauth` | `https://api.cline.bot/api/v1/chat/completions` | quirks: clineEnvelope |
| `codebuddy-cn` | CodeBuddy CN | `openai` | `oauth` | `https://copilot.tencent.com/v2/chat/completions` | force-stream |
| `codebuddy-intl` | CodeBuddy | `openai` | `oauth` | `https://www.codebuddy.ai/v2/chat/completions` | force-stream |
| `codex` | OpenAI Codex | `openai-responses` | `apikey` | `https://chatgpt.com/backend-api/codex/responses` | force-stream, display-flag: deprecated |
| `cursor` | Cursor IDE | `cursor` | `apikey` | `https://api2.cursor.sh` | — |
| `github` | GitHub Copilot | `openai` | `apikey` | `https://api.githubcopilot.com/chat/completions` | display-flag: deprecated |
| `gitlab` | GitLab Duo | `openai` | `apikey` | `https://gitlab.com/api/v4/chat/completions` | — |
| `grok-cli` | Grok CLI (Grok Build) | `openai-responses` | `oauth` | `https://cli-chat-proxy.grok.com/v1/responses` | force-stream |
| `iflow` | iFlow AI | `openai` | `apikey` | `https://apis.iflow.cn/v1/chat/completions` | — |
| `kilocode` | Kilo Code | `openai` | `apikey` | `https://api.kilo.ai/api/openrouter/chat/completions` | passthrough-models |
| `kimi` | Kimi | `claude` | `oauth` | `https://api.kimi.com/coding/v1/messages` | urlSuffix ?beta=true |
| `qoder` | Qoder | `openai` | `oauth` | `https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_c...` | — |
| `trae` | Trae | `openai` | `oauth` | `https://core-normal.trae.ai/api/remote/v1` | — |
| `windsurf` | Windsurf | `openai` | `oauth` | `https://server.codeium.com/exa.language_server_pb.Languag...` | — |
| `xai` | xAI (Grok) | `openai` | `oauth` | `https://api.x.ai/v1/chat/completions` | — |
| `xiaomi-mimo` | Xiaomi MiMo | `openai` | `oauth` | `https://api.xiaomimimo.com/v1/chat/completions` | — |
| `zed` | Zed | `openai` | `oauth` | `https://cloud.zed.dev/completions` | passthrough-models, force-stream |


**OAuth mechanism split** — where the implementation lives upstream:
- **Registry-declared flow** (generic device-code/authorize handler works): cline, clinepass, codebuddy-cn, codebuddy-intl, grok-cli, kimchi, kimi, qoder, trae, windsurf, xai, xiaomi-mimo, zed
- **Server-side bespoke flow** (hand-written in `src/lib/oauth/` + `src/app/api/oauth/`): antigravity, claude, codex, cursor, github, gitlab, iflow, kilocode

### 4.3 Free tier (18)

| id | name | format | auth | baseUrl | notes |
|---|---|---|---|---|---|
| `api-airforce` | API.airforce | `openai` | `apikey` | `https://api.airforce/v1/chat/completions` | passthrough-models, force-stream |
| `bazaarlink` | Bazaarlink | `openai` | `apikey` | `https://bazaarlink.ai/api/v1/chat/completions` | — |
| `byteplus` | BytePlus ModelArk | `openai` | `apikey` | `https://ark.ap-southeast.bytepluses.com/api/coding/v3/cha...` | — |
| `cloudflare-ai` | Cloudflare | `openai` | `apikey` | `https://api.cloudflare.com/client/v4/accounts/{accountId}...` | — |
| `coqui` | Coqui TTS | `openai` | `none` | — | — |
| `edge-tts` | Edge TTS | `openai` | `none` | — | — |
| `gemini` | Gemini | `gemini` | `apikey` | `https://generativelanguage.googleapis.com/v1beta/models` | — |
| `google-tts` | Google TTS | `openai` | `none` | — | — |
| `kilo-gateway` | Kilo Gateway | `openai` | `apikey` | `https://api.kilo.ai/api/gateway/chat/completions` | — |
| `kimchi` | Kimchi | `openai` | `oauth` | `https://llm.kimchi.dev/openai/v1/chat/completions` | passthrough-models |
| `local-device` | Local Device | `openai` | `none` | — | — |
| `nvidia` | NVIDIA NIM | `openai` | `apikey` | `https://integrate.api.nvidia.com/v1/chat/completions` | — |
| `ollama` | Ollama Cloud | `ollama` | `apikey` | `https://ollama.com/api/chat` | — |
| `openrouter` | OpenRouter | `openai` | `apikey` | `https://openrouter.ai/api/v1/chat/completions` | passthrough-models |
| `poolside` | Poolside | `openai` | `apikey` | `https://inference.poolside.ai/v1/chat/completions` | — |
| `searxng` | SearXNG | `openai` | `none` | — | — |
| `tortoise` | Tortoise TTS | `openai` | `none` | — | — |
| `vertex` | Vertex AI | `vertex` | `apikey` | `https://aiplatform.googleapis.com` | — |

### 4.4 Free (no auth) (5)

| id | name | format | auth | baseUrl | notes |
|---|---|---|---|---|---|
| `devin-cli` | Devin CLI | `openai` | `none` | `devin://acp/stdio` | — |
| `gemini-cli` | Gemini CLI | `gemini-cli` | `apikey` | `https://cloudcode-pa.googleapis.com/v1internal` | display-flag: deprecated |
| `kiro` | Kiro AI | `kiro` | `apikey` | `https://runtime.us-east-1.kiro.dev/generateAssistantResponse` | display-flag: deprecated |
| `mimo-free` | MiMo Code Free | `openai` | `none` | `https://api.xiaomimimo.com/api/free-ai/openai/chat` | passthrough-models |
| `opencode` | OpenCode Free | `openai` | `none` | `https://opencode.ai` | passthrough-models |

### 4.5 Web-cookie (browser session hijack style) (2)

| id | name | format | auth | baseUrl | notes |
|---|---|---|---|---|---|
| `grok-web` | Grok Web (Subscription) | `grok-web` | `cookie` | `https://grok.com/rest/app-chat/conversations/new` | passthrough-models |
| `perplexity-web` | Perplexity Web (Pro/Max) | `perplexity-web` | `cookie` | `https://www.perplexity.ai/rest/sse/perplexity_ask` | — |


Media providers (TTS/STT/image/video/search) are configured separately in
`open-sse/config/mediaConfig.js` — out of routy v1 scope (deferred), cataloged on request.

## 5. Custom executors (the expensive list)

Default executor = generic POST + retry + fallback (~185 LOC). Anything below needs bespoke
code to port later. LOC = upstream file size, proxy for complexity.

| provider | executor file | LOC | why custom |
|---|---|---|---|
| `kiro` | `open-sse/executors/kiro.js` | 1303 | ConversationState format, SigV4-style auth, session replay |
| `cursor` | `open-sse/executors/cursor.js` | 1114 | protobuf body + checksum headers |
| `devin-cli` | `open-sse/executors/devin-cli.js` | 848 | proprietary devin protocol |
| `qoder` | `open-sse/executors/qoder.js` | 705 | custom envelope + encoding + context tiers |
| `antigravity` | `open-sse/executors/antigravity.js` | 653 | Gemini-family + quota/strike semantics |
| `windsurf` | `open-sse/executors/windsurf.js` | 589 | RegisterUser/Firebase auth lifecycle |
| `grok-cli` | `open-sse/executors/grok-cli.js` | 553 | Responses variant + reasoning effort rules |
| `perplexity-web` | `open-sse/executors/perplexity-web.js` | 506 | web scraping |
| `codex` | `open-sse/executors/codex.js` | 501 | Responses API + ChatGPT OAuth |
| `github` | `open-sse/executors/github.js` | 435 | Copilot device flow + editor headers |
| `grok-web` | `open-sse/executors/grok-web.js` | 344 | web scraping |
| `trae` | `open-sse/executors/trae.js` | 340 | AWS SigV4 signing |
| `commandcode` | `open-sse/executors/commandcode.js` | 323 | proprietary format |
| `zed` | `open-sse/executors/zed.js` | 305 | Zed auth |
| `opencode-go` | `open-sse/executors/opencode-go.js` | 183 | per-model endpoint support matrix |
| `vertex` | `open-sse/executors/vertex.js` | 178 | GCP auth + regions |
| `mimo-free` | `open-sse/executors/mimo-free.js` | 168 | Xiaomi free-tier account cycling |
| `kimchi` | `open-sse/executors/kimchi.js` | 124 | Kimi-variant headers |
| `opencode` | `open-sse/executors/opencode.js` | 117 | free-tier routing |
| `iflow` | `open-sse/executors/iflow.js` | 109 | cookie-based SSO |
| `xiaomi-mimo` | `open-sse/executors/xiaomi-mimo.js` | 100 | Xiaomi auth |
| `gemini-cli` | `open-sse/executors/gemini-cli.js` | 90 | Google OAuth + project IDs + SSE dialect |
| `codebuddy-cn` | `open-sse/executors/codebuddy-cn.js` | 70 | cn/intl split |
| `azure` | `open-sse/executors/azure.js` | 58 | deployment-key URLs |
| `codebuddy-intl` | `open-sse/executors/codebuddy-intl.js` | 45 | cn/intl split |
| `xiaomi-tokenplan` | `open-sse/executors/xiaomi-tokenplan.js` | 21 | Xiaomi token plan |
| `ollama-local` | `open-sse/executors/ollama-local.js` | 15 | local format quirks |

## 6. Token refresh inventory (for future OAuth work)

`open-sse/services/tokenRefresh/providers.js` (707 LOC) implements per-provider refresh:
`refreshAccessToken(provider, ...)` generic profile-driven refresh + bespoke:
xai, kimi, cline, claude, google, codex, kiro, iflow, github, copilot, codebuddy-cn,
codebuddy-intl, trae, zed(null), windsurf(skip). All wrapped in `dedupRefresh()`
(`tokenRefresh/dedup.js`) to prevent stampedes. Background scheduler:
`src/sse/services/backgroundTokenRefresh.js`.

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

- `display.deprecated` flag is set on antigravity, claude, codex, gemini-cli, github, kiro —
  in context this marks deprecated *connect modes* (legacy import paths), not the providers.
- Free/freeTier auth types are informational; several "apikey" free-tier providers work
  with throwaway keys.
- Registry `transport.executor` is uniformly "default"; do not trust it for porting
  decisions — use section 5 (executors/index.js wiring) instead.
