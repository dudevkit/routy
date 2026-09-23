# routy quickstart

routy is a local AI gateway: one OpenAI/Anthropic-compatible endpoint in front of
any number of upstream providers, with translation, fallback, breaker-protected
retries, token saving and cost accounting.

**Requires Node 22.5+** for the built-in `node:sqlite`. Node 24 is recommended —
on 22.5–23.3 that module needs `NODE_OPTIONS=--experimental-sqlite`.

---

## Run it

### From source

```bash
cd routy-core
npm ci
npm run build          # optional: produces dist/routy.mjs + dist/ui
node bin/routy.mjs serve
```

### From the single-file bundle

```bash
npm --prefix routy-core ci
node routy-core/scripts/build.mjs          # -> routy-core/dist/routy.mjs (~1.6 MB, no deps)
node routy-core/dist/routy.mjs serve
```

The bundle inlines everything except Node builtins. `dist/ui` (the dashboard) is
copied next to it automatically when `routy-ui/dist` exists.

### With Docker

```bash
docker build -t routy .
docker run -d --name routy -p 8010:8010 -v routy-data:/data routy
```

The image sets `ROUTY_HOST=0.0.0.0`, so non-loopback callers need the bootstrap
token for `/api` and a valid API key for `/v1`.

### As a Windows background task

See [windows-service.md](./windows-service.md) — scheduled task with
restart-on-failure, plus the graceful-stop story (Windows has no `SIGTERM`).

---

## First run

```bash
routy init
```

The wizard probes an upstream, issues a router API key, and offers to point a CLI
tool (Claude Code's `settings.json`) at routy. Everything it writes lands in
`ROUTY_HOME` (default `~/.routy`): `config.json`, `data/routy.db`, `gateway.lock`.

By hand, the same thing:

```bash
# 1. issue a client key (sk-…; it stays copyable from the Overview page)
routy key

# 2. add a provider
curl -s localhost:8010/api/nodes -H 'content-type: application/json' -d '{
  "name": "My provider", "prefix": "mp",
  "baseUrl": "https://api.example.com/v1", "apiKey": "sk-…"
}' | jq .

# 3. add a model by hand and prove it serves (importing the list is optional)
curl -s localhost:8010/api/nodes/<id>/models -H 'content-type: application/json' \
  -d '{"model":"<model>"}' | jq .
curl -s -X POST localhost:8010/api/nodes/<id>/models/<modelRowId>/test | jq .

# 4. use it
curl -s localhost:8010/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"mp/<model>","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

`GET /v1/models` lists every routable id: provider-prefixed models, aliases and combos.

---

## The Providers page

Click a provider in **Providers** to open its own page, with three tabs:

- **Models** — the list is **discovery-only**; it never gates routing. Either
  **Import from provider** (fetches its `/models` and merges — manual entries are
  kept, and ones the provider dropped are marked *stale* rather than deleted), or
  just type an id and hit **Test**. Test sends a real one-token stream, so a green
  result means the id genuinely serves. Each row has a copy button for the routable
  `<prefix>/<model>`, and **Select** turns on checkboxes with select-all plus bulk
  **Test / Hide / Show / Delete** over the selection.
- **API Keys** — add one key, or **Add bulk** with one per line as
  `label,key` (a bare key gets an auto label). *Test each key after adding* probes
  every new key, and **Test all keys** re-checks the lot.
- **Settings** — the provider's config, plus reset-breaker, disable and delete.

Testing is **diagnostics, not traffic**: a key or model probe never counts toward
usage, the daily budget or the breaker state. Testing a bad key can't take a healthy
provider offline.

### When something times out

Open **Live Console**. Every probe logs what it sent, what came back, and — on
failure — *which stage* died:

```
INFO  PROBE  → ts/deepseek-v4-flash:free   {url, budgetMs:45000, key:"twst1 key"}
INFO  PROBE  ← ok ts/deepseek-v4-flash:free {ttftMs:30370, via:"reasoning_content"}
WARN  PROBE  ✖ ts/deepseek-v4.1-flash:free  {stage:"connect", error:"no response within 45000ms"}
```

`stage: connect` means headers never arrived (network, auth, or the provider queued
you); `stage: first-token` means the stream opened and then went silent. Switch the
console's **capture** selector to `debug` and you also get every upstream dispatch,
response, retry and stream end — `UPSTREAM` lines with URL, model, byte count, TTFB
and duration. That setting is live and survives restarts.

---

## Point a CLI tool at it

Any tool that takes an OpenAI-compatible base URL works:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8010/v1` |
| API key | an `sk-…` client key from the Overview page (required unless `requireApiKey` is off) |
| Model | `<node-prefix>/<model>`, an alias, or a combo name |

Claude Code additionally works against `/v1/messages` — routy translates between the
OpenAI and Anthropic shapes in both directions, streaming included.

---

## Dashboard

Open <http://127.0.0.1:8010/> (or `/ui/`). Providers, combos and aliases, usage,
token saver, proxy pools, a live console and settings. It is a static bundle served
by the gateway itself — no separate process, and a broken UI cannot affect the
proxy.

---

## Next

- [configuration.md](./configuration.md) — every env var, config key and node knob
- [windows-service.md](./windows-service.md) — run it as a service
- `GET /metrics` — Prometheus text for requests, tokens, cost, TTFT, breakers, pools
