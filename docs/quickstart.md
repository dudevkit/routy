# RE-E quickstart

RE-E is a local AI gateway: one OpenAI/Anthropic-compatible endpoint in front of
any number of upstream providers, with translation, fallback, breaker-protected
retries, token saving and cost accounting.

**Requires Node 22.5+** for the built-in `node:sqlite`. Node 24 is recommended —
on 22.5–23.3 that module needs `NODE_OPTIONS=--experimental-sqlite`.

---

## Run it

### From source

```bash
cd re-e-core
npm ci
npm run build          # optional: produces dist/re-e.mjs + dist/ui
node bin/re-e.mjs serve
```

### From the single-file bundle

```bash
npm --prefix re-e-core ci
node re-e-core/scripts/build.mjs          # -> re-e-core/dist/re-e.mjs (~1.6 MB, no deps)
node re-e-core/dist/re-e.mjs serve
```

The bundle inlines everything except Node builtins. `dist/ui` (the dashboard) is
copied next to it automatically when `re-e-ui/dist` exists.

### With Docker

```bash
docker build -t re-e .
docker run -d --name re-e -p 8010:8010 -v re-e-data:/data re-e
```

The image sets `RE_E_HOST=0.0.0.0`, so non-loopback callers need the bootstrap
token for `/api` and a valid API key for `/v1`.

### As a Windows background task

See [windows-service.md](./windows-service.md) — scheduled task with
restart-on-failure, plus the graceful-stop story (Windows has no `SIGTERM`).

---

## First run

```bash
re-e init
```

The wizard probes an upstream, issues a router API key, and offers to point a CLI
tool (Claude Code's `settings.json`) at RE-E. Everything it writes lands in
`RE_E_HOME` (default `~/.re-e`): `config.json`, `data/re-e.db`, `gateway.lock`.

By hand, the same thing:

```bash
# 1. point a client key at the gateway (printed once)
re-e key

# 2. add an upstream
curl -s localhost:8010/api/nodes -H 'content-type: application/json' -d '{
  "name": "My provider", "prefix": "mp",
  "baseUrl": "https://api.example.com/v1", "apiKey": "sk-…"
}' | jq .

# 3. prove it
curl -s -X POST localhost:8010/api/nodes/<id>/test | jq .

# 4. use it
curl -s localhost:8010/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"mp/<model>","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

`GET /v1/models` lists every routable id: node-prefixed models, aliases and combos.

---

## Point a CLI tool at it

Any tool that takes an OpenAI-compatible base URL works:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8010/v1` |
| API key | a `re-e key` value (required unless `requireApiKey` is off) |
| Model | `<node-prefix>/<model>`, an alias, or a combo name |

Claude Code additionally works against `/v1/messages` — RE-E translates between the
OpenAI and Anthropic shapes in both directions, streaming included.

---

## Dashboard

Open <http://127.0.0.1:8010/> (or `/ui/`). Upstreams, combos and aliases, usage,
token saver, proxy pools, a live console and settings. It is a static bundle served
by the gateway itself — no separate process, and a broken UI cannot affect the
proxy.

---

## Next

- [configuration.md](./configuration.md) — every env var, config key and node knob
- [windows-service.md](./windows-service.md) — run it as a service
- `GET /metrics` — Prometheus text for requests, tokens, cost, TTFT, breakers, pools
