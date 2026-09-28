// 9Router's media provider catalogue, expressed as routy data.
//
// The rule this repo works under — all providers similar, differences are DATA — is what makes this
// file possible: every entry below is a provider 9Router ships, and what routy needs to speak to it
// is an endpoint, an auth style, and (for the web kinds) a mapping. Nothing here is a guess: the
// entries were extracted from 9Router's own registry
// (`9router/open-sse/providers/registry/*.js`, 69 media entries) and its web cores
// (`handlers/search/callers.js`, `handlers/search/normalizers.js`, `handlers/fetch/index.js`).
//
// `supported: false` is not "missing": it names the code path 9Router uses and routy does not have.
// Those providers need a bespoke shape (a JSON-RPC envelope, a synthesised result, a chat prompt
// standing in for a search), which by the rule above is a change of its own rather than a config —
// and claiming support we cannot deliver would be the one thing worse than the gap.

/** A provider entry. `auth: null` means routy's default (bearer). */
const p = (id, name, url, auth, extra = {}) => Object.freeze({ id, name, url, auth, ...extra });

/** A search provider that needs an extra setting the operator must supply. */
const needs = (list) => (list ? { requires: list } : {});

const SEARCH = Object.freeze([
  p("tavily", "Tavily", "https://api.tavily.com/search", "bearer", {
    map: {
      request: { query: "query", max_results: "max_results" },
      static: { topic: "general" },
      response: {
        results: "results",
        fields: { title: "title", url: "url", snippet: "content", score: "score", published_at: "published_date", "content.text": "raw_content" },
        top: { answer: "answer" },
      },
    },
  }),
  p("exa", "Exa", "https://api.exa.ai/search", "x-api-key", {
    map: {
      request: { query: "query", max_results: "numResults" },
      static: { type: "auto", text: true, highlights: true },
      response: {
        results: "results",
        fields: { title: "title", url: "url", snippet: "highlights.0|text", score: "score", published_at: "publishedDate", author: "author", favicon_url: "favicon", "content.text": "text" },
      },
    },
  }),
  p("serper", "Serper", "https://google.serper.dev/search", "x-api-key", {
    map: {
      request: { query: "q", max_results: "num" },
      response: { results: "organic", fields: { title: "title", url: "link", snippet: "snippet", published_at: "date" } },
    },
  }),
  p("brave-search", "Brave Search", "https://api.search.brave.com/res/v1/web/search", "bearer", {
    authHeader: "x-subscription-token",
    map: {
      method: "GET",
      request: { query: "q", max_results: "count" },
      response: { results: "web.results", fields: { title: "title", url: "url", snippet: "description", published_at: "page_age", favicon_url: "meta_url.favicon" } },
    },
  }),
  p("google-pse", "Google Programmable Search", "https://www.googleapis.com/customsearch/v1", "query", {
    authQuery: "key",
    ...needs(["a `cx` search-engine id — set media.map.webSearch.static.cx on the node"]),
    map: {
      method: "GET",
      authQuery: "key",
      request: { query: "q", max_results: "num" },
      response: { results: "items", fields: { title: "title", url: "link", snippet: "snippet" } },
    },
  }),
  p("linkup", "Linkup", "https://api.linkup.so/v1/search", "bearer", {
    map: {
      request: { query: "q", max_results: "maxResults" },
      static: { depth: "standard", outputType: "searchResults" },
      response: { results: "results", fields: { title: "name", url: "url", snippet: "content", "content.text": "content" } },
    },
  }),
  p("searchapi", "SearchAPI", "https://www.searchapi.io/api/v1/search", "query", {
    authQuery: "api_key",
    map: {
      method: "GET",
      authQuery: "api_key",
      request: { query: "q" },
      static: { engine: "google" },
      response: { results: "organic_results", fields: { title: "title", url: "link", snippet: "snippet", published_at: "date" } },
    },
  }),
  p("youcom", "You.com", "https://ydc-index.io/v1/search", "x-api-key", {
    map: {
      method: "GET",
      request: { query: "query", max_results: "count" },
      response: { results: "results.web", fields: { title: "title", url: "url", snippet: "description", published_at: "page_age", favicon_url: "favicon_url" } },
    },
  }),
  p("searxng", "SearXNG (self-hosted)", "http://localhost:8888/search", "none", {
    map: {
      method: "GET",
      request: { query: "q" },
      static: { format: "json" },
      response: { results: "results", fields: { title: "title", url: "url", snippet: "content", published_at: "publishedDate" } },
    },
  }),
  p("ollama-search", "Ollama Search", "https://ollama.com/api/web_search", "bearer", {
    map: {
      request: { query: "query", max_results: "max_results" },
      response: { results: "results", fields: { title: "title", url: "url", snippet: "content", "content.text": "content", published_at: "published_at" } },
    },
  }),
  p("xquik", "Xquik (X search)", "https://xquik.com/api/v1/x/tweets/search", "x-api-key", {
    supported: false,
    why: "9Router synthesises each result (the tweet's url and title are built from the author and id) and paginates by cursor — a shape config cannot express (handlers/search/normalizers.js:203)",
  }),
  p("glm", "GLM web_search_prime", "https://api.z.ai/api/mcp/web_search_prime/mcp", "bearer", {
    supported: false,
    why: "JSON-RPC MCP envelope with the results as JSON inside a text content block (handlers/search/callers.js:415)",
  }),
  ...[
    ["openai", "OpenAI (via chat)", "gpt-4o-mini"],
    ["gemini", "Gemini (via chat)", "gemini-2.5-flash"],
    ["perplexity", "Perplexity", "sonar"],
    ["perplexity-agent", "Perplexity Agent", "perplexity/sonar"],
    ["kimi", "Kimi", "kimi-k3"],
    ["minimax", "Minimax", "MiniMax-M2.7"],
    ["xai", "xAI (Grok)", "grok-4.20-reasoning"],
    ["antigravity", "Antigravity", "gemini-2.5-flash"],
    ["vercel-ai-gateway", "Vercel AI Gateway", "openai/gpt-4o-mini"],
  ].map(([id, name, model]) =>
    p(id, name, null, null, {
      supported: false,
      chatModel: model,
      why: `9Router answers search by prompting a chat model (searchViaChat: ${model}) — routy has no chat-search path`,
    }),
  ),
]);

const FETCH = Object.freeze([
  p("firecrawl", "Firecrawl", "https://api.firecrawl.dev/v1/scrape", "bearer", {
    map: {
      request: { url: "url", format: "formats" },
      arrays: ["formats"],
      response: { fields: { title: "data.metadata.title", "content.text": "data.markdown|data.text|data.html" } },
    },
  }),
  p("jina-reader", "Jina Reader", "https://r.jina.ai/", "bearer", {
    map: {
      request: { url: "url" },
      response: { text: true, titleRegex: ["^\\s*Title:\\s*(.+)$", "^\\s*#\\s+(.+)$"] },
    },
  }),
  p("tavily", "Tavily", "https://api.tavily.com/extract", "bearer", {
    map: {
      request: { url: "urls" },
      arrays: ["urls"],
      static: { extract_depth: "basic" },
      response: { fields: { title: "results.0.title", "content.text": "results.0.raw_content" } },
    },
  }),
  p("exa", "Exa", "https://api.exa.ai/contents", "x-api-key", {
    map: {
      request: { url: "ids" },
      arrays: ["ids"],
      static: { text: true },
      response: { fields: { title: "results.0.title", "content.text": "results.0.text" } },
    },
  }),
  p("ollama", "Ollama Cloud", "https://ollama.com/api/web_fetch", "bearer", {
    map: {
      request: { url: "url" },
      response: { fields: { title: "title", "content.text": "content", links: "links" } },
    },
  }),
]);

// Embeddings: every one of these speaks the OpenAI shape except Gemini, which 9Router converts to
// `embedContent`/`batchEmbedContents` server-side.
const EMBEDDING = Object.freeze([
  p("openai", "OpenAI", "https://api.openai.com/v1/embeddings", "bearer", { models: ["text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002"] }),
  p("openrouter", "OpenRouter", "https://openrouter.ai/api/v1/embeddings", "bearer", { models: ["openai/text-embedding-3-large", "openai/text-embedding-3-small"] }),
  p("mistral", "Mistral", "https://api.mistral.ai/v1/embeddings", "bearer", { models: ["mistral-embed"] }),
  p("voyage-ai", "Voyage AI", "https://api.voyageai.com/v1/embeddings", null, { models: ["voyage-3-large", "voyage-3.5", "voyage-code-3"] }),
  p("jina-ai", "Jina AI", "https://api.jina.ai/v1/embeddings", "bearer", { models: [] }),
  p("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1/embeddings", null, { models: ["nomic-ai/nomic-embed-text-v1.5"] }),
  p("together", "Together AI", "https://api.together.xyz/v1/embeddings", null, { models: ["BAAI/bge-large-en-v1.5"] }),
  p("nebius", "Nebius AI", "https://api.tokenfactory.nebius.com/v1/embeddings", null, { models: ["Qwen/Qwen3-Embedding-8B"] }),
  p("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1/embeddings", "bearer", { models: ["nvidia/nv-embedqa-e5-v5"] }),
  p("github", "GitHub Models", "https://models.github.ai/inference/embeddings", "bearer", { models: ["text-embedding-3-small", "text-embedding-3-large"] }),
  p("vercel-ai-gateway", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1/embeddings", null, { models: [] }),
  p("selfhosted-embedding", "Self-hosted Embedding", "http://localhost:8080/v1/embeddings", "bearer", { models: ["embedding"] }),
  p("gemini", "Gemini", "https://generativelanguage.googleapis.com/v1beta/models", "key", {
    supported: false,
    why: "9Router converts the OpenAI request to `batchEmbedContents` and back (open-sse/handlers/embeddingProviders/gemini.js) — a converter, not a mapping",
  }),
]);

// Images: the OpenAI `/images/generations` shape is the uniform path; the rest are the adapters
// 9Router keeps one file per provider for.
const IMAGE = Object.freeze([
  p("openai", "OpenAI", "https://api.openai.com/v1/images/generations", "bearer", { models: ["gpt-image-2.5", "gpt-image-2", "gpt-image-1.5"] }),
  p("xai", "xAI (Grok)", "https://api.x.ai/v1/images/generations", "bearer", { models: ["grok-2-image-1212"] }),
  p("recraft", "Recraft", "https://external.api.recraft.ai/v1/images/generations", "bearer", { models: ["recraftv3", "recraftv2"] }),
  p("vercel-ai-gateway", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1/images/generations", null, { models: [] }),
  p("minimax", "Minimax", "https://api.minimaxi.com/v1/images/generations", "bearer", { models: ["minimax-image-01"] }),
  ...[
    ["gemini", "Gemini", "only `prompt` is accepted; `size` and `n` are ignored (open-sse/handlers/imageProviders/gemini.js)"],
    ["codex", "Codex", "the image arrives as an SSE stream (open-sse/handlers/imageProviders/codex.js)"],
    ["nanobanana", "NanoBanana", "a submit-then-poll API (imageProviders/nanobanana.js)"],
    ["fal-ai", "Fal.ai", "a queue with its own submit/poll protocol (imageProviders/falAi.js)"],
    ["black-forest-labs", "Black Forest Labs", "a submit-then-poll API (imageProviders/blackForestLabs.js)"],
    ["runwayml", "Runway ML", "async submit + poll (imageProviders/runwayml.js)"],
    ["stability-ai", "Stability AI", "`size` is translated to `aspect_ratio` (imageProviders/stabilityAi.js)"],
    ["huggingface", "HuggingFace", "one image per call, no parameters (imageProviders/huggingface.js)"],
    ["sdwebui", "SD WebUI", "a local non-OpenAI API (imageProviders/sdwebui.js)"],
    ["comfyui", "ComfyUI", "a local workflow API (imageProviders/comfyui.js)"],
    ["cloudflare-ai", "Cloudflare AI", "account-scoped paths and a bespoke body (imageProviders/cloudflareAi.js)"],
    ["antigravity", "Antigravity", "an OAuth-backed internal endpoint (imageProviders/antigravity.js)"],
  ].map(([id, name, why]) => p(id, name, null, null, { supported: false, why })),
]);

// TTS: OpenAI's `/audio/speech` is the uniform path. `format` is 9Router's own selector for the
// code path each provider needs, quoted so the work is visible rather than assumed.
const TTS = Object.freeze([
  p("openai", "OpenAI", "https://api.openai.com/v1/audio/speech", "bearer", { models: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"] }),
  p("selfhosted-tts", "Self-hosted TTS", "http://localhost:8880", null, { models: ["kokoro"] }),
  ...[
    ["elevenlabs", "ElevenLabs", "https://api.elevenlabs.io/v1/text-to-speech", "elevenlabs", "the voice is part of the path and `xi-api-key` carries the key"],
    ["gemini", "Gemini", "https://generativelanguage.googleapis.com/v1beta/models", "gemini-tts", "`generateContent` with an audio response modality"],
    ["minimax", "Minimax", "https://api.minimax.io/v1/t2a_v2", "minimax-tts", "its own `t2a_v2` body and hex audio in the reply"],
    ["minimax-cn", "Minimax (China)", "https://api.minimaxi.com/v1/t2a_v2", "minimax-tts", "its own `t2a_v2` body and hex audio in the reply"],
    ["nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1/audio/speech", "nvidia-tts", "a different body per voice model"],
    ["cartesia", "Cartesia", "https://api.cartesia.ai/tts/bytes", "cartesia", "its own body and `x-api-key`"],
    ["inworld", "Inworld", "https://api.inworld.ai/tts/v1/voice", "inworld", "basic auth and base64 audio"],
    ["playht", "PlayHT", "https://api.play.ht/api/v2/tts/stream", "playht", "a streaming protocol with its own auth pair"],
    ["fish-audio", "Fish Audio", "https://api.fish.audio/v1/tts", "fish-audio", "its own body"],
    ["edge-tts", "Edge TTS", "edge-tts", "edge-tts", "a local binary, not an HTTP endpoint"],
    ["google-tts", "Google TTS", "google-tts", "google-tts", "a local integration, not an HTTP endpoint"],
    ["local-device", "Local Device", "local-device", "local-device", "shells out to the OS speech engine"],
    ["coqui", "Coqui", "http://localhost:5002/api/tts", "coqui", "a local non-OpenAI API"],
    ["tortoise", "Tortoise", "http://localhost:5000/api/tts", "tortoise", "a local non-OpenAI API"],
    ["xiaomi-mimo", "Xiaomi MiMo", "https://api.xiaomimimo.com/v1/chat/completions", "xiaomi-mimo-tts", "synthesises through a chat completion"],
    ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1/chat/completions", null, "its TTS route is a chat completion"],
  ].map(([id, name, url, format, why]) => p(id, name, url, null, { supported: false, format, why })),
]);

/** The catalogue, by kind. Frozen: this is data the API serves and the UI renders. */
export const MEDIA_CATALOG = Object.freeze({
  webSearch: SEARCH,
  webFetch: FETCH,
  embedding: EMBEDDING,
  image: IMAGE,
  tts: TTS,
});

/**
 * Card metadata a Media screen needs and 9Router ships: where to GET a key, the provider's own
 * notice (free tier, pricing, quirks) and whether it has a free tier. Keyed by id because the
 * answer is the same in every kind it appears in — one OpenAI key page, one set of rules.
 */
const META = Object.freeze({
  "brave-search": { keyUrl: "https://api-dashboard.search.brave.com/app/keys", },
  cartesia: { keyUrl: "https://play.cartesia.ai/keys" },
  "cloudflare-ai": { keyUrl: "https://dash.cloudflare.com/profile/api-tokens", free: true, notice: "Workers AI free tier. Requires a Cloudflare API token and Account ID." },
  coqui: { },
  elevenlabs: { keyUrl: "https://elevenlabs.io/app/settings/api-keys" },
  exa: { keyUrl: "https://dashboard.exa.ai/api-keys" },
  "fal-ai": { keyUrl: "https://fal.ai/dashboard/keys", free: true },
  firecrawl: { keyUrl: "https://www.firecrawl.dev/app/api-keys" },
  fireworks: { keyUrl: "https://fireworks.ai/account/api-keys" },
  "fish-audio": { keyUrl: "https://fish.audio/app/api-keys/" },
  gemini: { keyUrl: "https://aistudio.google.com/app/apikey", free: true },
  glm: { keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  "google-pse": { keyUrl: "https://programmablesearchengine.google.com/controlpanel/create" },
  "huggingface": { keyUrl: "https://huggingface.co/settings/tokens", free: true },
  inworld: { keyUrl: "https://platform.inworld.ai/api-keys", notice: "Free tier: 40 minutes/month TTS. Paid: TTS-1.5 Mini $0.01/min, TTS-1.5 Max $0.025/min." },
  "jina-ai": { keyUrl: "https://jina.ai/?sui=apikey", notice: "10M free tokens on signup (non-commercial), no credit card required." },
  "jina-reader": { keyUrl: "https://jina.ai/?sui=apikey", free: true },
  kimi: { keyUrl: "https://platform.moonshot.ai/console/api-keys" },
  linkup: { keyUrl: "https://app.linkup.so/api-keys" },
  minimax: { keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key" },
  "minimax-cn": { keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key" },
  mistral: { keyUrl: "https://console.mistral.ai/api-keys" },
  nanobanana: { keyUrl: "https://nanobananaapi.ai/dashboard", free: true, notice: "3rd-party proxy for Google Nano Banana. For the official one, use the Gemini provider." },
  nebius: { keyUrl: "https://studio.nebius.com/settings/api-keys" },
  nvidia: { keyUrl: "https://build.nvidia.com/settings/api-keys", free: true, notice: "Free access for NVIDIA Developer Program members (prototyping & testing)." },
  ollama: { keyUrl: "https://ollama.com/settings/keys", free: true, notice: "Free tier: light usage, 1 cloud model at a time (limits reset every 5h and 7d)." },
  "ollama-search": { keyUrl: "https://ollama.com/settings/keys", notice: "Web search via Ollama Cloud. Reuses the API key from the Ollama (chat) provider." },
  openai: { keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { keyUrl: "https://openrouter.ai/settings/keys", free: true, notice: "Free tier: 27+ free models, no credit card, 200 req/day." },
  perplexity: { keyUrl: "https://www.perplexity.ai/settings/api" },
  "perplexity-agent": { keyUrl: "https://www.perplexity.ai/settings/api", notice: "Perplexity Agent exposes GPT, Claude, Gemini, Grok, GLM, Kimi and Sonar through one API." },
  playht: { keyUrl: "https://play.ht/studio/api-access" },
  recraft: { keyUrl: "https://www.recraft.ai/profile/api" },
  searchapi: { keyUrl: "https://www.searchapi.io/dashboard" },
  searxng: { notice: "Self-hosted. No key — point the URL at your instance." },
  serper: { keyUrl: "https://serper.dev/api-key" },
  "stability-ai": { keyUrl: "https://platform.stability.ai/account/keys" },
  tavily: { keyUrl: "https://app.tavily.com/home", free: true, notice: "1,000 free searches/month on signup." },
  together: { keyUrl: "https://api.together.xyz/settings/api-keys" },
  "vercel-ai-gateway": { keyUrl: "https://vercel.com/dashboard/~/ai-gateway", notice: "Unified OpenAI-compatible endpoint; one AI Gateway key covers every model it fronts." },
  "voyage-ai": { keyUrl: "https://dash.voyageai.com/api-keys" },
  xai: { keyUrl: "https://console.x.ai" },
  youcom: { keyUrl: "https://api.you.com" },
  xquik: { keyUrl: "https://xquik.com", notice: "Searches public X posts. Billing uses 1 Xquik credit per returned post." },
});

/** The card metadata for one provider id (empty when the provider says nothing). */
export function catalogMeta(id) {
  return META[id] ?? {};
}


/** Every entry of a kind (empty for a kind with no catalogue — chat). */
export function catalogFor(kind) {
  return MEDIA_CATALOG[kind] ?? [];
}

export function catalogEntry(kind, id) {
  return catalogFor(kind).find((entry) => entry.id === id) ?? null;
}

/** What the UI offers as a starting point, and the count it can honestly claim. */
export function catalogSummary(kind) {
  const all = catalogFor(kind);
  const supported = all.filter((e) => e.supported !== false);
  return { kind, total: all.length, supported: supported.length, unsupported: all.length - supported.length };
}

/**
 * The node fragment a preset fills in: the endpoint for this kind, the auth style the provider
 * uses, its media models, and — for the web kinds — the mapping. Deliberately the same shape a
 * user would type, so applying a preset and editing by hand are the same act.
 */
export function presetFor(kind, id) {
  const entry = catalogEntry(kind, id);
  if (!entry || entry.supported === false) return null;
  const data = { media: { kinds: [kind], provider: entry.id } };
  if (entry.url) data.media.urls = { [kind]: entry.url };
  if (entry.auth) data.media.auth = { [kind]: { style: entry.auth } };
  if (entry.map) data.media.map = { [kind]: entry.map };
  return {
    id: entry.id,
    name: entry.name,
    data,
    models: entry.models ?? [],
    requires: entry.requires ?? [],
  };
}
