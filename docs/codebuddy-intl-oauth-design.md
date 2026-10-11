# CodeBuddy Intl OAuth multi-account design

**Status:** Proposed; not implemented
**Scope:** Add CodeBuddy Intl (`www.codebuddy.ai`) as an OAuth-backed chat provider with multiple independently managed accounts in Routy.
**Reference:** Local `9router/` checkout; paths below are relative to that checkout unless noted otherwise.

## 1. Goal and non-goals

Allow an operator to connect one or more CodeBuddy Intl accounts in the Routy dashboard, route chat requests using existing connection rotation/fallback, refresh OAuth credentials safely, and independently reconnect or remove each account.

In scope:

- Provider-specific browser login/poll flow; multiple OAuth connections on one CodeBuddy node.
- Server-side credential persistence and refresh; safe account management UI.
- CodeBuddy-specific chat headers/body transformation and supported streaming modes.
- Deterministic protocol/API tests using local stubs only.

Not in scope:

- A generic OAuth framework or CodeBuddy CN (`copilot.tencent.com`).
- API-key auth, billing/quota UI, media endpoints, or a live `/models` discovery integration.
- General credential encryption-at-rest, schema-wide connection redesign, or changes to normal API-key routing policy.
- Real CodeBuddy calls in automated tests or any automated provider-quota use.

## 2. Existing behavior and verified reference

### Routy constraints

- Each provider node owns connection rows; each row stores `credentials` JSON. `connections.create/update/delete` operate per row. `withTransaction(db, fn)` exists in `db/driver.mjs`, but the API receives `repos`, not the raw database. Add a repository-level atomic operation for OAuth transactions and credential compare-and-swap; do not leak the raw DB handle.
- Existing connection endpoints are API-key-centric: create accepts `{ apiKey }`, list views mask the API key, and `NodeConnection` is typed around `keyMasked`. OAuth access/refresh tokens must never be put in `apiKey` or returned in connection/node JSON.
- `DefaultExecutor` adds `Bearer <apiKey>`. The CodeBuddy executor needs an OAuth credential resolver and explicit provider-specific selection.
- `pickConnections` uses ordinary connection `status` plus breaker health. Existing 401/403 handling can strike and disable API-key connections; CodeBuddy OAuth must have a distinct lifecycle and must not inherit that mutation accidentally.
- Chat forces/handles SSE in existing code: non-streaming OpenAI-compatible requests can be converted from forced SSE to OpenAI JSON using `parseSSEToOpenAIResponse`. Cross-format non-stream response translation is not generally provided.
- Dashboard management APIs use dashboard authorization; state-changing routes require `sameOriginAction` (`x-routy-action: 1`). Provider catalog entries are currently API-key/free-tier presets, not OAuth providers.

### 9Router CodeBuddy Intl protocol

Reference files:

- OAuth: `9router/src/lib/oauth/providers/codebuddy-intl.js`
- OAuth constants: `9router/src/lib/oauth/constants/oauth.js`
- Poll route: `9router/src/app/api/oauth/[provider]/[action]/route.js`
- Refresh: `9router/open-sse/services/tokenRefresh/providers.js`, `refreshCodebuddyIntlToken`
- Registry: `9router/open-sse/providers/registry/codebuddy-intl.js`
- Chat transform: `9router/open-sse/executors/codebuddy-intl.js`

Observed upstream flow:

1. `POST https://www.codebuddy.ai/v2/plugin/auth/state?platform=ide`, body `{}`, with CodeBuddy OAuth User-Agent `IDE/2.63.2 CodeBuddy/2.63.2`, `X-Requested-With`, `X-Domain`, `X-No-Authorization`, `X-No-User-Id`, `X-Product`, JSON content type and accept headers.
2. Success is `{ code: 0, data: { state, authUrl } }`. `state` is the polling handle; `authUrl` is the browser verification URL. Despite the reference's `device_code` label, this is not the standard OAuth device authorization grant.
3. Poll `GET https://www.codebuddy.ai/v2/plugin/auth/token?state=<encoded-state>` every 5 seconds with the reference no-auth/request headers plus `X-No-Enterprise-Id` and `X-No-Department-Info`. `{ code: 11217 }` means pending. `{ code: 0, data: { accessToken, refreshToken, tokenType, expiresIn } }` succeeds.
4. Refresh with `POST https://www.codebuddy.ai/v2/plugin/auth/token/refresh`, body `{}`, and the refresh token in `X-Refresh-Token`, plus `X-Domain`, `X-Auth-Refresh-Source: plugin`, `X-Product`, and the OAuth User-Agent. If no rotated refresh token is returned, retain the old one. The reference defaults a missing/falsy `expiresIn` to 86400 seconds; Routy will default only an omitted expiry and reject explicit malformed/nonpositive values.
5. The OAuth token mapping has no email/profile identity. Use a local operator label; do not claim a verified email.

Chat uses `https://www.codebuddy.ai/v2/chat/completions`, forces streaming, and sets registry headers including User-Agent `IDE/2.108.1 CodeBuddy/2.108.1`, `X-Product: SaaS`, `X-IDE-Type`, `X-IDE-Name`, `x-requested-with`, and `x-codebuddy-request: 1`.

## 3. User experience

### Entry points and accounts

- Add **CodeBuddy Intl · OAuth** as a dedicated entry in an **OAuth providers** section, separate from the API-key preset/free-tier groups. First-account setup asks for the Routy node name and unique prefix.
- On the resulting provider detail page expose **Connect another account**. It creates another OAuth connection on that same node.
- Each row shows local account label, `OAuth`, auth lifecycle state, ordinary enabled/disabled state, transient health/cooldown, priority, last test result, and row-scoped rename/enable/disable/reconnect/remove actions. Never show or copy tokens.
- Reconnect explicitly targets one row and replaces only that row's OAuth credentials after success. Failure preserves the old row credentials. It must not silently create a duplicate or overwrite every account.
- Because upstream returns no verified identity, labels are operator-provided or generated (`CodeBuddy account 2`, etc.). `connections.name` is canonical; the safe view can expose it as `accountLabel`.

### Login lifecycle

1. Operator chooses first setup, add-account, or reconnect for a row and optionally enters a label. UI starts the flow and keeps the returned opaque local `flowId` in component memory only.
2. Once start returns a verified URL, render a prominent user-clickable link with `target="_blank"` and `rel="noopener noreferrer"`. Do not rely on calling `window.open` after `await` (browsers may block it). Show polling progress and cancel/retry guidance.
3. UI sends same-origin `POST` poll calls every 5 seconds. Pending is an ordinary state, not an error or connection row.
4. On success, server creates exactly one node+connection, adds one connection to an existing node, or updates only the explicitly targeted reconnect row. It returns safe metadata and removes sensitive flow state.
5. A cancelled or expired flow creates no partial first node/account if cancellation wins before commit. If the synchronous commit wins the documented race, report its sanitized success rather than claiming cancellation. Terminal upstream error or persistence failure creates no partial first node/account; failed reconnect leaves the prior connection unchanged. Report safe, actionable errors.

## 4. Backend design

### Provider-scoped routes and flow state

Keep implementation CodeBuddy-specific; do not introduce a generic OAuth framework.

- `POST /api/providers/codebuddy-intl/oauth/start` accepts one explicit intent: `create` with initial node name/prefix, `add` with node ID, or `reconnect` with connection ID and optional new label. It starts upstream state and returns `{ flowId, verificationUrl, expiresAt, pollIntervalMs }`; never returns upstream `state` separately.
- `POST /api/providers/codebuddy-intl/oauth/flows/:flowId/poll` makes at most one upstream poll and returns a safe discriminated state: `pending`, `complete` with safe node/connection view, or `failed` with safe error code/message. Repeated poll after completion returns only the sanitized terminal result.
- `DELETE /api/providers/codebuddy-intl/oauth/flows/:flowId` cancels a pending flow. It returns no upstream state/token data.

All routes require existing dashboard authorization. Start, poll, and cancel must enforce `sameOriginAction`. Validate methods, body size, intent, node/connection ownership and provider marker, and required initial name/prefix. Prefix conflicts return 409. The client cannot choose upstream URLs. Do not use GET for poll: a poll can consume upstream state and persist a connection.

Use an in-memory `Map` keyed by a cryptographically random 32-byte local flow ID (256 bits), containing only the upstream polling state, expiry, intent/node/new-node input, optional target connection ID, requested label, phase, and sanitized terminal result. Bind the flow to that intent so a flow cannot attach to another node/account. Upstream state is never persisted in the DB or browser. Local flow IDs remain in component memory and never enter browser storage, address bar, logs, or telemetry. This v1 in-memory design requires start/poll/cancel requests to reach the same gateway process (single instance or guaranteed sticky routing); without that deployment guarantee, use a shared server-side flow store before enabling OAuth on multiple instances. Process restart invalidates outstanding flows; the UI must start a new login, and no partial DB mutation may result.

Bound resource use server-side: at most 20 outstanding flows per process, 10-minute expiry, and no more than one new upstream poll per flow every 4 seconds (UI cadence is 5 seconds). Reject excess starts and early polls with HTTP 429 and a bounded `Retry-After`; do not call upstream on rejection. Serialize in-flight polling per flow; a concurrent poll returns safe pending or 409 without issuing another upstream call. Expire the map with an unref'd cleanup timer. Retain sanitized terminal results briefly (e.g. two minutes) so a lost HTTP response can be retried idempotently, then delete them. Do not retain tokens in terminal results.
Model each flow with an atomic phase transition (`pending` → `polling` → `committing` → `complete`, or terminal `cancelled`/`expired`/`failed`). Poll acquires a per-flow lock before transitioning to `polling`; `DELETE` and expiry arbitrate atomically with poll/commit. While upstream polling is in flight, cancellation/expiry wins by making the flow terminal; a later upstream success is discarded without persistence. After token validation, poll re-checks that the same flow remains live and uncancelled immediately before atomically entering `committing` and starting the synchronous repository transaction. Once that transition/transaction has begun, commit wins: DELETE returns the sanitized completed result, not a false cancellation. Keep the flow entry until arbitration settles; never remove it while poll/commit is in flight.

Never log upstream state, verification URL/query, access/refresh tokens, or raw upstream response bodies. Apply a bounded timeout and response-body size limit to every OAuth state/poll/refresh request. Convert errors to bounded safe provider error codes/messages; do not interpolate untrusted response text into dashboard errors or logs. The only response containing the verification URL is the validated start response; treat its query as sensitive and never persist/log it.

### Provider URL allowlist gate

The `authUrl` returned by CodeBuddy must be parsed and validated before returning it to the UI: require HTTPS, reject credentials/fragments/unsafe schemes, and permit only exact CodeBuddy-controlled hostnames maintained in a compile-time allowlist. Never accept a verification URL from the client or use an unrestricted HTTPS check.

**Verified (2026-10-11, live `POST https://www.codebuddy.ai/v2/plugin/auth/state?platform=ide`, one login-state request, no account/quota):** the response `authUrl` is `https://www.codebuddy.ai/login?platform=ide&state=…` — same host as every registry endpoint (`stateUrl`/`tokenUrl`/`refreshUrl`/chat), HTTPS, path `/login`, query keys `platform` and `state` only. The compile-time allowlist is therefore exactly **`www.codebuddy.ai`** (hostname match, case-insensitive, exact — no suffix wildcard). Keep the check fail-closed: any other host, a non-HTTPS scheme, credentials in the URL, or a fragment is rejected. Do not widen it speculatively.

### Persisted credentials and safe views

Store OAuth credentials in existing connection JSON, distinctly from API-key rows:

```json
{
  "authType": "oauth",
  "accessToken": "…",
  "refreshToken": "…",
  "expiresAt": "2026-10-11T12:00:00.000Z",
  "authState": "active",
  "oauthRevision": 1,
  "providerSpecificData": {}
}
```

`authState` belongs in OAuth credential JSON, not `connections.status` or breaker state. Its bounded values are `active` and `reauth-required`. Newly created rows start `active`. For legacy/malformed OAuth rows: a missing `authState` is treated as `active` only after validating a nonempty access token; malformed state/credentials fail closed and require reconnect rather than leaking into API-key behavior. API-key rows have no OAuth state. `oauthRevision` is a non-secret monotonically increasing credential version for compare-and-swap; it may be stored in the JSON, so no schema column is required.

`expiresAt` is computed from a finite positive `expiresIn`; omitted expiry uses the reference's 86400-second default, while malformed, non-finite, zero, or negative explicit values are rejected intentionally (unlike the reference's broad falsy fallback). Require a nonempty access token and accept only the expected bearer token type (or absent token type, which defaults to Bearer); reject unsupported token types. Missing refresh token is allowed, but an expired access token then requires re-login. Do not store an unverified identity in `providerSpecificData`.

For first setup, create the node and first connection in one DB transaction via a repository operation that invalidates node/connection caches after commit and leaves no orphan on rollback. Existing `withTransaction` is synchronous; keep DB writes synchronous within the repository operation. Pre-check prefix uniqueness and handle unique-index races as 409. The transaction itself creates a protected server-owned node marker (for example `data.authProvider: "codebuddy-intl-oauth"`); generic node create/update must not be able to set, change, or remove that marker. For add/reconnect validate the exact persisted marker and verify the target connection belongs to it. Reconnect atomically replaces only OAuth credential fields after token validation; do not route through the ordinary node-level API-key replacement endpoint.

Extend safe connection views and UI types with nonsecret `authType`, `accountLabel`, and `authState`. For OAuth, `keyMasked` is a generic `OAuth` label or null, never derived from tokens. Never serialize the credential object. Existing rename/priority/proxy/status operations must preserve all OAuth fields. All generic API-key credential writes to a CodeBuddy OAuth node are rejected atomically; mixed OAuth/API-key connections are out of scope.

### Token refresh, dispatch, and auth failure policy

- Resolve credentials for each selected connection immediately before upstream chat. Refresh when `expiresAt` is within a 5-minute lead window; do not refresh forever for legacy rows with no expiry.
- Use the fixed refresh endpoint and headers. Deduplicate upstream refreshes by CodeBuddy provider plus an ephemeral HMAC fingerprint of the refresh token (never log/store the fingerprint); this prevents two independently stored rows sharing one refresh token from racing a rotation. Each row still applies the shared result under its own per-connection lock and `oauthRevision` compare-and-swap; do not merge rows or assume shared identity. Atomically persist access token, rotated refresh token (or prior token), expiry, `authState`, and incremented `oauthRevision`; invalidate connection cache.
- Serialize refresh and reconnect through the same per-connection async lock, held across upstream request and persistence. Every OAuth credential mutation must use it. Also use a conditional repository write against the observed `oauthRevision` (and/or refresh token) from before the upstream request. If a reconnect or other writer installed newer credentials, discard the stale refresh response and use the latest row. Cache invalidation alone is not concurrency control. Refresh deduplication across rows does not replace row-specific CAS.
- If `expiresAt` is past and there is no refresh token, the account cannot refresh and must reconnect; expose it as `reauth-required` without claiming a provider-side revocation. Set `reauth-required` after a refresh response only when invalid/revoked is definitive. Exact terminal error codes are not established by the local reference; until verified, ambiguous failures remain transient. A network/5xx refresh failure preserves credentials/state, fails this attempt without breaker/key-health penalty, and allows fallback to another eligible connection/node.
- `pickConnections` keeps the existing active-status and breaker filters, then excludes only OAuth rows with `authState === "reauth-required"`. Do not repurpose generic connection status or breaker state for auth lifecycle.
- For CodeBuddy OAuth only, a definitive bearer-auth rejection should trigger at most one forced refresh and replay on that same account. A confirmed HTTP 401 is a candidate. Treat 403 as terminal auth rejection only if an unambiguous provider-specific signal is verified; the local reference does not establish that classification, so until verified do not classify 403 by status or ambiguous body alone (403 may mean permission or credit). If the retried request is also definitively rejected, or refresh is definitively invalid/revoked, persist `reauth-required`. Do not invoke generic API-key strike/auto-disable or node-breaker paths for this OAuth auth failure. Do not replay on ambiguous 403, credit/request errors, or transient refresh failure. Preserve ordinary `connections.status` so operator disable remains independent.
- If every OAuth connection needs reauth, report that actionable state (provider prefix only), not “keys cooling down.” A manual disable continues to take precedence even if OAuth `authState` is active. API-key 401/403 behavior remains unchanged.

### Chat executor and supported request modes

Select a provider-specific executor only from the exact server-owned CodeBuddy OAuth marker created by the OAuth repository transaction; generic node creation cannot set it. The CodeBuddy executor must target the exact fixed chat endpoint `https://www.codebuddy.ai/v2/chat/completions` (or use an explicitly protected `data.chatUrl` containing exactly that endpoint); it must not pass the full endpoint as `baseUrl` and then inherit `DefaultExecutor.buildUrl()` appending another `/chat/completions`. Test the final request URL exactly. Runtime selection verifies the stored OAuth marker, expected `apiType`, and endpoint; malformed/edited OAuth nodes fail closed instead of sending bearer credentials elsewhere. The ordinary node-update API may edit the display name but must reject changes to protected `apiType`, `baseUrl`, and executor/chat URL marker. Never activate an executor based on arbitrary user URLs or executor strings.
Because API-key auth and mixed-auth nodes are out of scope, every generic API-key write path must reject writes to a CodeBuddy OAuth node: node update with `apiKey`, single/batch connection creation, and generic credential replacement must return a clear 409/400 and leave state unchanged. The ordinary node-update handler writes `apiKey` to the primary connection, so explicitly guard it; guard both single and batch connection-create handlers too. Determine OAuth mode from persisted server-side node metadata, not client input alone. Do not permit an API-key connection to be silently routed through the OAuth executor or vice versa; preserve API-key behavior for non-OAuth nodes.

Port the verified request transform from `9router/open-sse/executors/codebuddy-intl.js`: force upstream `stream: true`, apply the reference reasoning-field behavior, prepend `You are CodeBuddy Code.`, drop client `system`/`developer` messages as reference does, convert plain-string user content to typed text blocks, and preserve assistant/tool messages without inventing semantics. Add the fixed registry headers and use the resolved OAuth bearer access token.

For non-streaming OpenAI-compatible requests, preserve Routy's existing forced-SSE-to-OpenAI-JSON path and test it with CodeBuddy SSE fixtures, including tool/reasoning content, usage, and malformed/empty stream errors. Non-streaming requests that require cross-format response translation are **not supported in v1**: return a clear unsupported-mode error until reverse response translation is implemented and tested. Streaming uses Routy's supported passthrough/translation path. Do not claim full non-streaming compatibility beyond the implemented OpenAI-compatible path.
CodeBuddy chat error handling must also be provider-specific: the shared `DefaultExecutor` currently reads and debug-logs upstream response-body text. For CodeBuddy OAuth failures, consume/bound the body but expose only HTTP status, allowlisted provider error codes, and generic safe messages; do not pass raw bodies to logs, API error details, request-detail captures, or test results. Preserve the structured status needed for the single refresh/replay policy. Test responses containing fake access/refresh tokens and verify no secret-like value escapes through logs, client errors, or stored diagnostics.

### OAuth-specific diagnostics, no model discovery

Existing `probeKey` and `probeModel` use `credentials.apiKey`, call `/models` or send a generic chat body, and do not invoke a provider executor. They cannot validate CodeBuddy OAuth as-is. The per-account **Test** action must be explicitly user-initiated, clearly disclose that it sends one real minimal chat request and may consume provider quota, and use a CodeBuddy-specific probe with the same credential resolver, one-refresh policy, headers, and request transform; use a deterministic tiny-token probe prompt/model. Do not run OAuth probes automatically, on page load, in background checks, or through bulk Test without a separate explicit confirmation. Before any upstream request, every management route that can trigger OAuth Test—including per-connection and model-row Test—must call `sameOriginAction` (the current generic handlers are not guarded). Reject missing action header/mismatched Origin with zero upstream calls. Record only the per-connection test result; do not record usage, change budget, breakers, automatic key health, or traffic health. Do not call `/models` for OAuth key testing or assume a live model-list API exists. Disable node-wide/bulk OAuth probes unless separately and explicitly confirmed and guarded. Seed only documented/manual discovery models; keep model rows discovery-only.

## 5. Persistence, rotation, and recovery

- Each login is a separate connection row. Existing order/rotation remains the account-selection policy; never merge accounts based on token equality or unverified identity.
- Add-account creates a fresh connection. Reconnect targets one row and preserves old credentials on every failure. Remove/rename/enable/disable/priority are row-scoped.
- If persistence fails after upstream token success, do not claim success; drop transient token references where practical. A failed initial transaction leaves no node. A failed reconnect leaves its prior credentials intact.
- Routy currently stores API credentials as plaintext JSON in local SQLite. OAuth inherits that posture; this design does not claim encryption at rest. A general credential-encryption project is separate.

## 6. Test plan

All provider calls use injected fetch/local stubs; never spend CodeBuddy quota.

### Protocol tests

- State POST URL/query/body/headers and valid response; non-2xx, malformed JSON, missing state/auth URL, invalid URL host/scheme; secrets/raw upstream body absent from errors/logs.
- Poll GET URL encoding and required headers; `11217` pending, token success, missing access token, other provider errors, network failures and malformed JSON.
- Refresh POST headers and `X-Refresh-Token` placement, rotated/retained refresh token, expiry validation, transient versus definitive failure classification, and secret redaction.
- Flow limits, unknown/wrong/expired IDs, server-side minimum poll interval, concurrent poll serialization, cancellation, terminal-result replay, TTL cleanup, and no upstream request for rejected early/excess polls.

### API, persistence, routing, and executor tests

- Initial completion creates exactly one node+connection atomically; duplicate prefix conflict; additional login appends exactly one connection; reconnect changes only its target; failed reconnect preserves credentials.
- Safe API/node/connection views never include tokens; ordinary rename/priority/proxy/status operations preserve OAuth fields; caches invalidate after transaction/CAS writes.
- Dashboard authorization and same-origin action guards cover start/poll/cancel. No client-supplied URL can reach fetch/open.
- Test per-connection and model-row OAuth probe routes reject missing `x-routy-action: 1` or mismatched Origin before any upstream call; test explicit quota disclosure and no automatic/page-load/bulk probe.
- Refresh concurrency and reconnect race prove stale refresh cannot overwrite newer credentials; refresh-token rotation persists before subsequent requests.
- Generic node update with `apiKey` and single/batch API-key connection creation reject OAuth-only nodes atomically without changing state; corresponding API-key management remains unchanged for other nodes.
- Dispatch excludes only `reauth-required` OAuth rows; manual disable and API-key routing retain existing semantics. Terminal OAuth auth rejection causes one refresh/replay at most, does not disable the row or poison node breaker, and does not change API-key 401/403 behavior.
- Concurrent refreshes from two rows sharing the same refresh token issue one upstream refresh using provider plus ephemeral HMAC fingerprint single-flight; each row applies the result with independent revision CAS. Confirm the fingerprint is not persisted or logged.
- If all OAuth rows require reauth, response is reconnect-specific and does not say keys are cooling down.
- Explicitly user-initiated OAuth Test discloses quota use, uses a minimal chat probe rather than `/models`, and never runs on page load/in background or without confirmed bulk action. It never records usage/budget/breaker/traffic health; no automatic model discovery is presented.
- Chat requests pin endpoint, headers, bearer token, body adaptation, forced SSE, OpenAI non-stream SSE-to-JSON conversion, supported stream translations, and explicit rejection of non-stream cross-format cases.
- CodeBuddy chat errors with fake access/refresh token strings in upstream bodies expose no raw body or secret through logs, gateway/API errors, probe results, or stored request diagnostics; only bounded allowlisted codes and safe messages escape.

## 7. Suggested implementation sequence

1. ~~Confirm the exact CodeBuddy verification hostname allowlist~~ **DONE (2026-10-11):** host is `www.codebuddy.ai`, pinned by a live state request; the exact-host check ships.
2. Verify the exact fixed chat target and protected executor marker against ordinary node-update behavior; reject generic API-key writes to the OAuth-only node in node update and single/batch connection creation. Test the final outbound URL to prevent accidental duplicate `/chat/completions`.
3. Implement the tested OAuth protocol client and bounded in-memory flow manager.
4. Add repository transaction/CAS helpers, OAuth credential resolver, per-connection lock, cross-row refresh single-flight, refresh persistence, and routing/auth-failure handling.
5. Add explicit CodeBuddy executor selection, request transform, guarded chat probe and SSE conversion tests.
6. Add provider-scoped routes and safe connection view metadata.
7. Add dashboard OAuth provider onboarding and account management (create/add/reconnect/cancel/error/accessibility states); keep it out of API-key presets.
8. Run core suite, UI typecheck/build, security review, and mocked local browser flow; no live quota calls in CI.

## 8. Open decisions and release gates
1. **Deployment affinity:** Flow state is process-local in v1. Use one gateway process or guaranteed sticky routing for start/poll/cancel; otherwise add a shared server-side flow store before multi-instance deployment.
2. **Verification URL hostnames:** ~~not verified~~ **CLOSED (2026-10-11):** live state request returned `https://www.codebuddy.ai/login?platform=ide&state=…`; allowlist is exactly `www.codebuddy.ai`. Start may ship with the exact-host check.
3. **Refresh terminal semantics:** Verify CodeBuddy's exact error codes that prove a refresh token is revoked/invalid before persisting `reauth-required`; otherwise keep failures retryable.
4. **At-rest encryption:** Existing credentials are plaintext. Decide separately if a cross-provider encryption design is needed.
5. **Cross-format non-streaming:** Explicitly unsupported in v1 until reverse response translation is implemented and tested; OpenAI-compatible forced-SSE-to-JSON is supported.

## 9. Acceptance criteria

- Operator can connect a first account and an independent second account, then reconnect/remove one without changing peers.
- Tokens remain server-side, are never returned/logged, and rotated refresh credentials persist without refresh/reconnect races.
- Poll state is bounded, server-rate-limited, CSRF-protected, idempotent after completion, and safe across cancellation/expiry races. Process restart invalidates outstanding flows without partial persistence; the operator can safely start again.
- OAuth probe actions are same-origin guarded and explicitly user-initiated with quota disclosure; probes do not run automatically or mutate usage/health state.
- CodeBuddy chat error bodies are bounded and sanitized; tokens and raw upstream error text never reach logs, client errors, or stored diagnostics.
- The dashboard clearly distinguishes reauth-needed from manual disable and transient cooldown, without inventing account identity.
- Supported request modes behave according to CodeBuddy reference; unsupported non-stream cross-format requests fail clearly.
- Tests use stubs only and cover success, pending, cancellation, expiration, security, concurrency including shared-refresh-token rows, account isolation, probes, and response conversion.