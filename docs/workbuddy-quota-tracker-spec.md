# WorkBuddy quota tracker — Usage → Quota

**Status:** Proposed; not implemented.  
**Product surface:** Routy dashboard → **Usage** → **Quota**.  
**Provider:** WorkBuddy / CodeBuddy Intl, using `https://www.workbuddy.ai` in v1.

## 1. Goal and scope

Show WorkBuddy's provider-reported allowance for each connected OAuth account, separately from Routy's own recorded requests, tokens, and costs. Show a provider aggregate when valid, and current package rows that help explain it.

This is a read-only tracker. A deliberate, user-clicked refresh makes only the provider's billing-meter reads below. It does not send a model/chat request or buy credits, claim gifts, cancel renewals, or estimate a provider-credit-to-token conversion. No upstream reads run on page load, tab changes, gateway startup, timers, or background refetches.

Keep the existing Usage → Quota visualization, but label it **Usage share by node** and make clear that it is Routy-recorded usage, not remaining allowance. Add a distinct **Provider allowance** area for WorkBuddy accounts. The existing date range applies to Routy usage only; WorkBuddy allowance is current provider state with its own fetched time.

V1 covers personal WorkBuddy OAuth accounts only. Enterprise usage, historical/expired packages, purchases, gifts, renewal changes, and bulk refresh are out of scope.

## 2. Verified WorkBuddy contract

The WorkBuddy 5.5.2 client/reverse-engineered reference uses three authenticated `POST` meter endpoints. They read billing state; despite the HTTP method, these calls are not checkout or other mutation actions.

| Source | Path | Request body | Purpose |
|---|---|---|---|
| Summary | `/billing/meter/get-user-resource-summary` | `{}` | `Packages[]` cycle totals/used/remaining, `SubscriptionPackageCode`, `IsPaidUser` |
| Paid details | `/billing/meter/get-user-resource-paid-packages` | `{PageNumber, PageSize, PackageCodes, Status:[0,3], NeedRenewInfo:true}` | Paid plans and add-on packages |
| Free details | `/billing/meter/get-user-resource-free-packages` | `{PageNumber, PageSize, PackageCodes, Status:[0,3], SlicePeriodStartTime, SlicePeriodEndTime}` | Free, trial, and bonus packages; current slice capacity |

Use the fixed origin `https://www.workbuddy.ai`; never accept a URL/host from the dashboard. Do not prepend `/v2` to these paths: the reference uses an empty resource prefix for these meter endpoints. Redirects are disabled.

Billing headers:

```text
Authorization: Bearer <resolved access token>
X-User-Id: <verified account uid>
X-Domain: www.workbuddy.ai
Accept: application/json
Content-Type: application/json
Accept-Language: en
```

Routy does not yet have a dashboard locale contract; pin `Accept-Language: en` in v1. Add `zh` only if the dashboard locale is explicitly wired, validated, and included in cache identity. Do not send enterprise identity headers or call the separate enterprise endpoint in v1.

### Account identity required for meter requests

The OAuth token response contains tokens, not an account profile. The WorkBuddy 5.5.2 login flow has a state-bound follow-up `GET /v2/plugin/login/account?state=<encoded-state>` using the new bearer; the observed pending business code is `12151`. The WorkBuddy helper/research notes also identify `GET /v2/plugin/accounts` as an account lookup, but it can return multiple accounts and must not be used to guess which account belongs to a Routy connection.

During the existing explicit OAuth completion flow, make a bounded, state-bound login-account lookup while the flow still owns its private state. Handle only the observed pending code as retryable; cap attempts and total time. Capture only a validated, non-empty `uid` into private server-side OAuth credential metadata for that exact connection (for example `providerSpecificData.quotaIdentity.uid`). Never return or log the ID, token, raw response, or temporary state.

This lookup is optional to chat OAuth: if account identity is unavailable after the bounded attempt, finish connecting the chat account and expose a safe **quota identity unavailable** state. Quota refresh for that account fails closed until reconnect; do not omit `X-User-Id`, infer it from an unverified JWT, or bind an ambiguous account-list result. Existing connections without captured identity remain chat-capable but quota-ineligible until reconnect. Preserve this private metadata during access-token refresh; replace it only with a successful row-scoped reconnect. Routy stores OAuth credentials in local SQLite; this proposal does not claim encryption at rest.

### Request, response, and pagination rules

- Summary success requires HTTP success, `code === 0`, `data`, and `data.Packages` as an array. Package success requires HTTP success, `code === 0`, `data.Accounts` as an array, and a finite non-negative `TotalCount`. Missing/malformed collections are source failures, not empty balances.
- Package envelope: `{code:0,data:{Accounts:[...],TotalCount:n}}`. Summary envelope: `{code:0,data:{Packages:[...],...}}`.
- Pin paid `PackageCodes` to this 5.5.2 allowlist: `TCACA_code_002_AkiJS3ZHF5`, `TCACA_code_005_maRGyrHhw1`, `TCACA_code_003_FAnt7lcmRT`, `TCACA_code_023_4xbGhMrE6q`, `TCACA_code_026_BaESVICNoi`, `TCACA_code_027_0FCGVA6vSa`, `TCACA_code_009_0XmEQc2xOf`, `TCACA_code_038_OhvqZtiPKr`, `TCACA_code_036_lupO5WgNdG`.
- Pin free `PackageCodes` to this 5.5.2 allowlist: `TCACA_code_001_PqouKr6QWV`, `TCACA_code_008_cfWoLwvjU4`, `TCACA_code_035_ArVxJcGDsm`, `TCACA_code_006_DbXS0lrypC`, `TCACA_code_039_KRcQj7wUat`, `TCACA_code_040_mi9rCYg46x`, `TCACA_code_007_nzdH5h4Nl0`, `TCACA_code_028_NtpWi0jzXs`, `TCACA_code_037_WxOD3MpI2o`, `TCACA_code_029_6wCGEWquYy`, `TCACA_code_030_BjSt89qTvr`. Keep both lists server-side; clients cannot choose package codes.
- Page from 1 with `PageSize:200`, at most 10 pages per detail source. Stop on a short page or once fetched rows reach `TotalCount`. If `TotalCount` still exceeds fetched rows (including an early short-page inconsistency), mark that source truncated/incomplete; never silently report a complete inventory.
- The free endpoint receives the provider-local current-day slice window in `yyyy-MM-dd HH:mm:ss`, using the gateway's local timezone: local midnight through `23:59:59`. Display the timezone with the last-fetched/as-of information so the slice boundary is understandable.
- Do not call purchase, checkout, gift/check-in, promo-claim, renewal, or enterprise endpoints.

### Normalized resource and aggregate semantics

Return only normalized fields; never pass through raw billing JSON.

```ts
interface QuotaResource {
  resourceId: string;
  packageCode: string;
  name: string;
  total: number | null;
  used: number | null;
  remaining: number | null;
  unit: "credits" | "provider-units" | "unknown";
  status: "active" | "used-up" | "unknown";
  startsAt: string | null;
  expiresAt: string | null;
  resetsAt: string | null;
  capacityType: number | null;
  source: "paid" | "free";
}
```

- Parse only finite, non-negative numbers or numeric strings. Preserve numeric zero. Missing, malformed, non-finite, or negative values become `null` and make the relevant field/source incomplete; do not silently substitute zero. No negative/unlimited sentinel semantics are verified.
- For `CapacityType === 4`, prefer the first current `SlicePeriodUsageDetails` entry's `SlicePeriodCapacitySizePrecise` and `SlicePeriodCapacityRemainPrecise`; derive used only when both are valid. If slice detail is absent, fall back to `CycleCapacitySizePrecise` and `CycleCapacityRemainPrecise` (the desktop uses this fallback for free-month packages).
- For other current packages, use `CycleCapacitySizePrecise` and `CycleCapacityRemainPrecise`; use `CycleCapacityUsedPrecise` when valid, otherwise derive `max(0,total-remaining)` only when both inputs exist. Never mix measurement periods.
- Detail status `[0,3]` means valid or used-up. Keep exhausted packages visible. Refunded and expired-history packages are not requested in v1.
- Dedupe paid/free detail rows only by non-empty `ResourceId`; if duplicated across sources, paid wins and the duplicate may be counted in a sanitized diagnostic. Never dedupe distinct rows merely because their package codes match.
- The summary is the aggregate authority. Sum `data.Packages[].CycleTotalCapacity`, `CycleRemainCapacity`, and `CycleUsedCapacity` only if every required field is present, finite, and non-negative; otherwise the aggregate is null/incomplete. Do not substitute detail-row sums: the sources may overlap or intentionally suppress package families. Confirm summary-vs-detail behavior with fixtures before release.
- Keep completeness distinct: `aggregateComplete` describes the summary aggregate; `packageInventoryComplete` describes both detail sources and their pagination. A valid summary aggregate can coexist with a partial package inventory. If summary fails, preserve successful details but aggregate is null. If a detail source fails/truncates, preserve successful details but mark inventory incomplete. If all sources fail, show the error and any last-good snapshot as stale, never as current.
- Provider UI copy may say **credits** only after confirming that this account's provider-returned values use that unit; otherwise use **provider units**. Never convert these values to Routy tokens or dollars.

### Retry and resource limits

- Fetch summary, paid, and free sources independently; one source failure must not erase successes from the others.
- Retry network/no-status, HTTP 408, 429, and 5xx failures only: at most 3 attempts per failed source, exponential backoff from 1 second to 8 seconds with ±30% jitter. Do not retry ordinary 4xx or unverified business errors.
- Bound each request to 15 seconds and each response to 1 MiB. Bound each detail source to 10 pages/10 MiB and each explicit refresh to 60 seconds overall; cancel work at the deadline and mark unfinished sources incomplete. Disable redirects so the bearer cannot be forwarded elsewhere.
- Error DTOs expose safe source/status/provider business codes only. Never return/log raw response bodies, identity headers, `uid`, tokens, or credential-shaped exception text.

## 3. Routy API, cache, and DTO

Add:

```text
GET  /api/providers/workbuddy/quota
POST /api/providers/workbuddy/quota/refresh
```

`GET` uses normal `/api` dashboard authorization and returns safe account state plus the last-good in-memory snapshot only; it never contacts WorkBuddy. `POST` requires `x-routy-action: 1` and Routy's same-origin action checks. It requires a `connectionId` and refreshes exactly that account. Missing/unknown IDs are rejected. V1 has no refresh-all endpoint.

Server-side selection is limited to connections under a node with the protected `data.authProvider === "codebuddy-intl-oauth"` marker and OAuth credentials. POST also requires an active connection and effective OAuth auth state `active`. Disabled, `reauth-required`, missing-identity, API-key, or unrelated-provider rows must not cause billing calls. Respect `authStateOf` for legacy OAuth rows without an explicit `authState`. Never accept a base URL, token, identity, package list, or arbitrary node selection as upstream authority from the browser.

Resolve OAuth credentials using the existing resolver and single-flight/CAS behavior. Preserve private `providerSpecificData.quotaIdentity` when token refresh rewrites credentials. Transient refresh failures must not alter connection status, breakers, traffic, health, or probe results.

Keep last-good snapshots in process memory only, keyed by connection identity (connection ID plus the captured identity association; locale if locale support is later added). Do not key them only by `oauthRevision`, because an ordinary token rotation changes that revision without changing the account. `GET` returns `fetchedAt` and stale/fresh state. A POST performs a real refresh attempt; concurrent POSTs for the same connection may join the same in-flight operation, but a completed old cache is not a successful refresh. On refresh failure retain the last-good snapshot as stale with a safe error. Reconnect, removal, or identity change invalidates the old association. Before publishing a result, compare the current connection identity and the observed credential revision so a slow pre-reconnect response cannot overwrite newer account data. Do not persist snapshots to credentials, nodes, usage events, request logs, or disk; no snapshots survive a gateway restart.

Suggested response shape (never include the private `uid`):

```ts
interface WorkbuddyQuotaAccount {
  nodeId: string;
  nodePrefix: string;
  connectionId: string;
  accountLabel: string;
  connectionStatus: string;
  authState: "active" | "reauth-required";
  quotaIdentityAvailable: boolean;
  fetchedAt: string | null;
  stale: boolean;
  aggregateComplete: boolean;
  packageInventoryComplete: boolean;
  sources: Record<"summary" | "paid" | "free", {
    status: "success" | "failed" | "truncated" | "not-fetched";
    fetched: number | null;
    total: number | null;
    errorCode?: string;
  }>;
  aggregate: {
    total: number;
    used: number;
    remaining: number;
    unit: "credits" | "provider-units" | "unknown";
  } | null;
  subscriptionPackageCode: string | null;
  isPaidUser: boolean | null;
  resources: QuotaResource[];
  error?: { code: string; message: string };
}

interface WorkbuddyQuotaResponse {
  accounts: WorkbuddyQuotaAccount[];
}
```

Use the Routy connection name as `accountLabel`; do not claim a verified email/profile name.

## 4. Usage → Quota UI

1. Keep the existing date range and **Usage share by node** chart for Routy-recorded usage. A zero-usage empty state says “No routed usage in this range,” not “no quota.”
2. Add a visually separate **Provider allowance** area with one card per WorkBuddy OAuth connection. Never compare provider allowance directly with Routy's token/cost metrics.
3. Each card shows the Routy connection label and node prefix, ordinary enabled/disabled state, OAuth reauth state, identity eligibility, provider fetched time, and stale/partial status. Show aggregate remaining/total and used only when aggregate data is valid; guard unknown values and total zero in the progress bar.
4. Show expandable current package rows with provider name, remaining/total, used, active/exhausted state, and reset/expiry times where verified. Raw package code is optional disclosure for diagnosis, not primary UI.
5. Each eligible row has an explicit **Refresh** button. Explain that it performs WorkBuddy billing-meter reads (not model/chat tokens) and may be rate limited. No automatic refresh or bulk refresh.
6. Distinguish no WorkBuddy OAuth connections, disabled/reauth-required accounts, identity unavailable, no snapshot yet, stale data, partial source failure, and a complete zero allowance. Identify which source failed without displaying raw upstream text.
7. Keep refresh row-scoped and keyboard accessible. Announce loading/success/failure to assistive technology; ensure reconnecting one account cannot display another account's cached data.

## 5. Security and side-effect invariants

- Manual refresh only. A Usage screen load, tab switch, React Query timer, gateway boot, CI job, model import, key probe, or bulk provider probe never contacts the quota endpoints.
- Same-origin/action guard applies before provider calls. The API is server-side only and uses the fixed provider origin, fixed paths, and server-owned package lists.
- Do not expose OAuth tokens, `uid`, raw responses, raw error bodies, identity headers, or credential-shaped diagnostics in API responses, browser state, telemetry, or logs.
- Do not write `usage_events`, request details, budgets, breakers, connection health/status, `lastTest*`, model tests, or traffic analytics. This is a provider billing read, not a chat probe.
- Snapshots are in-memory and account-isolated. Treat old cached data as stale after reconnect/removal/identity change and fence in-flight responses against newer credentials.
- All automated tests use local fetch stubs and synthetic provider fixtures. CI never contacts WorkBuddy. Any optional live validation requires an explicit deliberate read-only call; never invoke checkout, gift, claim, or renewal endpoints.

## 6. Test plan

**Protocol and normalization**

- Exact paths, `POST` bodies, fixed host, `Accept-Language: en`, bearer/identity headers, redirect disabled, and no client-selected URL/package list.
- Summary and package success envelopes; nonzero business code, absent/malformed data, malformed JSON, 401/403, 408/429/5xx, network errors, timeouts, bounded retries, and no secret/raw-body leaks.
- OAuth login/account identity lookup: correct new bearer and private state; pending `12151` bounded retries; valid identity saved only to create/add/reconnect target; failure remains nonfatal to chat OAuth but quota-ineligible; no ID/state in public response or logs.
- Paid/free allowlists and exact page request bodies; free local-day slice boundaries and timezone; short page, `TotalCount`, duplicate IDs, cap/truncation, and source completeness.
- Numeric parser: valid zero, numeric strings, missing/malformed/negative/non-finite values; slice-capacity precedence and cycle fallback; ordinary cycle totals; current status and timestamps.
- Summary vs detail mismatch; summary failure with details success; detail-source failure with valid summary; partial and stale flags remain distinct.

**Routing, cache, and security**

- Only marked OAuth provider connections are eligible; API-key/unrelated nodes and disabled/reauth-required/missing-identity connections make zero provider calls. Legacy auth state uses the existing effective resolver.
- Missing `x-routy-action` or cross-origin action rejected before fetch; GET returns cached data with zero provider calls.
- Required connection ID refresh targets one row only. Same-account concurrent POST joins in-flight work; another account never shares its snapshot. A POST after TTL still attempts provider reads.
- Token refresh preserves private identity metadata; reconnect replaces it; stale in-flight results cannot repopulate a different identity's cache. Last-good survives transient failures as stale, but not as current.
- API responses/logs omit access/refresh token, `uid`, state, raw provider envelope, and Authorization header. No usage/budget/breaker/status/test writes.

**UI**

- Existing `Usage?tab=quota` chart remains Routy usage and range affects only Routy history; provider allowance is separately timestamped.
- Multiple account labels, disabled/reauth-required, identity unavailable, zero allowance, no snapshot, partial/stale, and loading states render correctly.
- Component/tab load causes no refresh POST. Clicking a row refreshes only its connection. Verify accessible controls, focus, loading/error announcements, and responsive layout.

## 7. Implementation sequence

1. Add the bounded, state-bound WorkBuddy login/account lookup to OAuth completion and private identity metadata. Preserve it during token refresh and replace it on reconnect; keep login successful if lookup is unavailable.
2. Implement the meter client and response normalizer using fixed host/path/header/package allowlists and synthetic fixtures.
3. Implement partial-source semantics, page/request bounds, retry policy, process-local per-account cache, and identity/revision fencing.
4. Add normal-dashboard-authenticated cache-only GET and guarded, row-scoped manual POST refresh.
5. Add the separate WorkBuddy allowance UI to Usage → Quota without changing the meaning of the existing measured-usage date range.
6. Run local-stub unit/API tests, UI typecheck/build, and a browser flow against a stubbed gateway. Do not spend upstream quota in CI.

## 8. Release gates / remaining validation

1. **Identity endpoint integration:** the 5.5.2 helper/research notes observed the state-bound `/v2/plugin/login/account` path and pending code `12151`; pin its response/header behavior in local stubs before enabling quota reads. If identity cannot be captured, keep quota disabled for that connection.
2. **Units and labels:** confirm provider units from a known response/account display; otherwise use “provider units,” not “credits,” tokens, or dollars.
3. **Aggregate semantics:** confirm that the summary endpoint's `Packages[].Cycle*` is the intended aggregate and whether it intentionally excludes/suppresses detail families. Keep aggregate and detail completeness independent.
4. **Freshness:** v1 GET is cache-only; explicit POST refresh is upstream. Show fetched time/stale status and never poll automatically.
5. **Locale:** v1 is pinned to English; wire another language only with a validated dashboard locale and locale-separated cached snapshots.

## 9. Acceptance criteria

- Usage → Quota distinguishes Routy-recorded usage from WorkBuddy-reported account allowance and never conflates units.
- A deliberate row-scoped refresh uses only the documented three billing-meter reads and the correct account's verified `uid`; ineligible accounts do not cause calls.
- Summary totals and package rows are normalized according to the 5.5.2 contract. Missing, partial, truncated, or stale data is visibly incomplete, not represented as zero/current.
- GET is cache-only; no page-load/background calls. POST is guarded, bounded, row-scoped, and does not mutate Routy usage/health/test state.
- Tokens, account IDs, raw provider responses, and sensitive headers never leave private server-side handling. Local-stub tests cover protocol, cache, identity, and UI behavior; CI makes no WorkBuddy call.
- Routy's Usage date range continues to apply only to Routy history; provider allowance has its own fetched time and freshness state.
