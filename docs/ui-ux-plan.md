# routy UI/UX Audit and Architecture Plan

This document is the UI/UX audit and overhaul plan for routy's dashboard (`routy-ui`). It records the complete screen and component inventory, categorized findings with file and line evidence, concrete component-level recommendations, overhauls with blast radius, a prioritized roadmap, and explicit non-goals.

---

## 1. Inventory

### Screens (`src/screens/*`)

- `src/screens/Overview.tsx:94`: Gateway dashboard home. Provides clear health metrics and router endpoint copy chips (`line 116`), but intercepts provider card clicks with an unnecessary confirmation modal (`line 228`) and pluralizes single model counts as "1 models" (`line 62`).
- `src/screens/Upstreams.tsx:291`: Provider catalog and instance management. Offers clear catalog presets with preset model lists (`line 303`), but completely hides added preset providers from the main filterable provider table (`line 340`) and litters the chat list with irrelevant non-chat "not yet" cards (`line 201`).
- `src/screens/ProviderDetail.tsx:1029`: Provider configuration (Models, Keys, Settings). Features thorough diagnostic key and model probes with TTFT inspection (`line 213`), but lacks an interactive prompt test card and relies on undersized 28px buttons for mobile row operations (`line 496`).
- `src/screens/Combos.tsx:1`: Fallback combos and alias routing manager. Supports drag-and-drop reordering with live auto-save (`line 134`), but runs an isolated unauthenticated shadow fetch for models (`line 51`) and concatenates model names with primary badges without whitespace (`line 156`).
- `src/screens/Media.tsx:29`: Non-chat endpoint provider directory. Clearly groups endpoints by wire kind with honest catalog notices (`line 107`), but duplicates the page H1 heading (`line 93`) and renders awkward plurals like "0 customs" (`line 121`).
- `src/screens/MediaProvider.tsx:25`: Specialized media provider inspector. Reuses the battle-tested KeysTab and ModelsTab directly (`line 104`), but buries advanced routing knobs behind raw JSON configuration without inline validation.
- `src/screens/Usage.tsx:461`: Traffic analytics and request payload inspector. Provides synchronized time-series charts and detailed request/response drawer inspector (`line 297`), but references outdated "Settings" client key copy (`line 390`) and fixes the Quota title to "7d" regardless of range (`line 376`).
- `src/screens/TokenSaver.tsx:20`: RTK prompt compression status. Accurately links compression decisions to console log tags (`line 68`), but displays internal roadmap excuses and contract requests as user-facing cards (`line 80`) and links to the console without passing the RTK tag filter (`line 73`).
- `src/screens/ProxyPools.tsx:1`: Outbound proxy fleet manager. Displays distinct egress IP resolution per exit (`line 99`), but lacks bulk exit deletion and pagination for large exit fleets (`line 118`).
- `src/screens/ConsoleLog.tsx:73`: Real-time streaming gateway log viewer. Supports multi-level toggles and server-side capture level selection (`line 84`), but contains a singular/plural grammar defect ("1 lines", `line 225`) and displays an obsolete empty-state message claiming REQ logs are unimplemented (`line 250`).
- `src/screens/CliTools.tsx:54`: Local AI CLI detection and auto-configuration. Accurately snapshots config files with byte-for-byte rollback (`line 14`), but stalls for 2.4s on load behind an uncommunicative 3-line skeleton (`line 76`) and duplicates the header H1 (`line 68`).
- `src/screens/Settings.tsx:415`: System configuration, security, budget, and updates. Consolidates critical gateway controls with live update checks (`line 250`), but uses a raw blocking `window.confirm` for server restarts (`line 361`) and mixes read-only telemetry with mutating form controls.
- `src/screens/Stub.tsx:5`: Catch-all wildcard route fallback. Renders cleanly with system icon, but misleads users by claiming the target route is an "unfinished preview slice" rather than an honest 404 (`line 11`).

### Shell and Feature Components (`src/components/*`)

- `src/App.tsx:47` (`Shell`): Application layout wrapper. Enforces `h-dvh` with iOS safe area handling (`line 68`), but injects an artificial 40px blueprint grid overlay across the whole app canvas (`line 64`).
- `src/components/Header.tsx:41`: Top navigation and status bar. Displays current route context and theme toggle (`line 70`), but runs an endless status dot animation on a static connection state (`line 75`).
- `src/components/Sidebar.tsx:70`: Desktop navigation rail. Clearly groups destinations with theme-aware wordmarks (`line 81`), but hardcodes an absolute tick offset that clips when container padding reflows (`line 60`).
- `src/components/MobileNav.tsx:14`: Mobile slide-over drawer. Mirrors desktop rail destinations faithfully (`line 40`), but fails to trap keyboard focus, fails to return focus on close, and duplicates the brand wordmark inside the drawer (`line 29`).
- `src/components/LoginGate.tsx:21`: Session authentication barrier. Offsets the login card for mobile keyboard appearance (`line 67`), but renders an uninformative bare text state while verifying session keys (`line 57`).
- `src/components/SecurityBanner.tsx:14`: Non-dismissible network exposure warning. Clearly states risk without marketing alarmism (`line 22`), but uses a raw `<a href="/settings">` tag that breaks React Router SPA navigation and `/ui` mounts (`line 25`).
- `src/components/UpdateCard.tsx:22`: Release announcement and binary apply card. Avoids auto-installing code without explicit operator consent (`line 16`), but uses an icon-only collapse action with ambiguous persistence behavior (`line 43`).
- `src/components/KeysCard.tsx:56`: Client API key management panel. Keeps keys copyable from creation onward (`line 51`), but forces immediate creation on enter without inline label editing.
- `src/components/NodeFormModal.tsx:63`: Provider creation and edit modal. Features live pre-save connection testing (`line 225`), but encourages trailing slashes with an erroneous `placeholder="or/"` (`line 213`) and contains duplicate CSS classes (`line 243`).
- `src/components/ModelPicker.tsx:30`: Grouped routable model selector. Correctly isolates aliases and combos from provider trees (`line 21`), but constructs malformed double prefixes like `p/p/model` when upstream models include prefixes (`line 99`).
- `src/components/CliToolDetail.tsx:19`: CLI tool configuration modal. Shows exact file mutations before writing (`line 141`), but fails to autofocus primary action inputs on mobile bottom sheets.
- `src/components/ExampleCard.tsx:23`: Media endpoint request builder and runner. Generates working curl commands with live masked keys (`line 95`), but relies on non-existent CSS utility `bg-background` (`line 204`) and fails to update state when model lists load asynchronously (`line 42`).
- `src/components/MediaProviderSettings.tsx:33`: Advanced per-kind endpoint and header tuner. Updates media objects atomically to avoid server-side field loss (`line 29`), but lacks structured query parameter builders for query-authenticated providers.
- `src/components/StatTile.tsx:9`: Top-level numeric metric tile. Employs tabular font numbers to stop layout jitter (`line 7`), but uses rigid text sizing that overflows on 320px viewports (`line 27`).
- `src/components/Sparkline.tsx:6`: Lightweight SVG trend line. Zero-dependency data visualization (`line 3`), but lacks accessible descriptions or screen-reader value equivalents (`line 31`).
- `src/components/CopyChip.tsx:13`: Masked credential with copy feedback. Handles fallback clipboard copying in insecure LAN contexts (`line 7`), but truncates without exposing a full tooltip on touch devices (`line 47`).
- `src/components/icons.tsx:1`: Phosphor SVG icon iconographic wrapper. Provides cohesive icon stroke weights and sizes (`line 1`), but lacks semantic titles for standalone icon buttons.

### UI Primitives (`src/components/ui/*`)

- `src/components/ui/Badge.tsx:28`: Semantic status pill. Maps status variants cleanly to palette tokens (`line 47`), but lacks border definition on low-contrast surface backgrounds.
- `src/components/ui/Button.tsx:29`: Standard interactive button. Handles loading spinners and disabled states consistently (`line 55`), but omits visible focus-visible indicators in Tailwind v4 and provides undersized 28px height on `sm` (`line 15`).
- `src/components/ui/Card.tsx:22`: Base container surface. Provides consistent surface tokens and border styling (`line 37`), but conflates interactive cards with structural layout cards via boolean props (`line 39`).
- `src/components/ui/CopyButton.tsx:11`: Inline clipboard trigger button. Halts click propagation on table rows (`line 30`), but lacks explicit `aria-label` when no title prop is provided (`line 28`).
- `src/components/ui/Drawer.tsx:10`: Right-side slide-over panel. Provides responsive width constraints and escape key listeners (`line 42`), but lacks a focus trap barrier for modal operation (`line 37`).
- `src/components/ui/Input.tsx:14`: Form text field primitive. Provides label, error, and hint slots (`line 26`), but strips all focus indicators due to broken `focus:ring` classes in Tailwind v4 (`line 43`).
- `src/components/ui/Modal.tsx:14`: Dialog overlay primitive. Reflows to a bottom sheet on mobile devices (`line 61`), but lacks focus restoration to triggering elements on dismiss.
- `src/components/ui/Select.tsx:12`: Native dropdown select wrapper. Preserves browser accessibility with styled trigger wrapper (`line 16`), but lacks explicit placeholder styling for unselected empty states.
- `src/components/ui/Skeleton.tsx:7`: Shimmer loading placeholder. Avoids external animation dependencies (`line 9`), but defaults to a generic 3-line shape that does not match card or table layouts.
- `src/components/ui/StatusDot.tsx:14`: System state colored dot. Separates status color from interactive primary hue (`line 5`), but permits uncontrolled infinite pulsing on non-transitioning states (`line 26`).
- `src/components/ui/Tabs.tsx:9`: Segmented control navigation. Clean visual indicator for active segment (`line 42`), but lacks keyboard arrow navigation across tabs per WAI-ARIA tablist patterns.
- `src/components/ui/ThemeToggle.tsx:5`: Theme switch button. Smoothly toggles dark and light mode classes (`line 26`), but lacks explicit indication of the active mode in screen reader text.
- `src/components/ui/Toast.tsx:44`: Floating notification manager. Stacks notifications predictably with auto-dismiss (`line 51`), but stacks notifications over the mobile header navigation area (`line 57`).
- `src/components/ui/Toggle.tsx:4`: Boolean switch component. Clear status indication with accessible role switch (`line 26`), but uses a small 36x20px hit area that fails minimum touch target guidelines on mobile (`line 32`).

### System Styles and Plumbing (`src/index.css`, `src/utils/*`, `src/hooks/*`)

- `src/index.css:1`: System theme definition and design tokens. Clean "Graphite Pro" dark palette (`line 88`), but exhibits failing WCAG AA contrast on subtle text (`line 47`), broken input ring utilities (`line 43`), and generic decorative grid background (`line 258`).
- `src/utils/clipboard.ts:13`: Resilient clipboard utility. Implements document.execCommand fallback for LAN HTTP deployments (`line 23`), but silent fallbacks can leave callers without actionable error feedback when browser security denies both.
- `src/utils/errors.ts:55`: User-facing error message normalizer. Translates cryptic SQLite constraints into human actionable sentences (`line 9`), but misses translation for newer transport failure codes.
- `src/utils/format.ts:1`: Timestamp and token unit formatting. Accurately distinguishes null from zero values (`line 41`), but lacks relative time formatters with locale customization.
- `src/utils/nodeStatus.ts:8`: Provider status visual mapping. Pairs color tokens with explicit text labels to prevent color-blind exclusion (`line 8`), but conflates down breakers with network unreachable states.
- `src/hooks/useCopy.ts:1`: Copy state transition hook. Enforces verified clipboard confirmation before indicating success (`line 16`), but lacks auto-reset cancellation on unmount.
- `src/hooks/useTheme.ts:1`: Theme state synchronization. Synchronizes dark class before first paint to eliminate white flash (`line 12`), but lacks system preference (`prefers-color-scheme`) auto-detection.

---

## 2. Findings

### Bugs

#### F-B01 (P0): Complete loss of input focus indicators across all form fields
- **Severity**: P0 broken
- **Evidence**: `src/index.css:320-323`, `src/components/ui/Input.tsx:43`, `src/components/NodeFormModal.tsx:37`, `src/screens/ProviderDetail.tsx:705`, `src/screens/ProxyPools.tsx:66`.
- **Interaction**: Pressing `Tab` to navigate into any input field (Overview key creation, Provider modal, search inputs, token inputs). Verified via Puppeteer computed styles: `boxShadow` resolves to `rgba(0, 0, 0, 0) 0px 0px 0px 0px` and `outline` resolves to `none`.
- **Consequence**: The cursor vanishes. Keyboard users and accessibility testers cannot determine where keyboard input will land.

#### F-B02 (P0): Overview "Manage in Upstreams" button triggers an uninformative modal with danger hover styling
- **Severity**: P0 broken
- **Evidence**: `src/screens/Overview.tsx:87-89`, `src/screens/Overview.tsx:228-247`.
- **Interaction**: Clicking "Manage in Upstreams" on any health card opens a modal stating "Removal is handled on the Upstreams screen, where the node's keys live" with a button linking to generic `/upstreams`. The trigger button carries `hover:text-danger`.
- **Consequence**: Users are stopped by a dead-end modal when expecting direct navigation to the provider detail screen (`/upstreams/:id`). The red hover text suggests deletion for a standard management link.

#### F-B03 (P0): Hardcoded `<a href="/settings">` in `SecurityBanner` breaks React Router SPA navigation
- **Severity**: P0 broken
- **Evidence**: `src/components/SecurityBanner.tsx:25-27`.
- **Interaction**: Clicking "Turn it on" when routy is served from `/ui/` (standard production bundle per `docs/configuration.md`).
- **Consequence**: The browser makes a full page GET request to `/settings` rather than `/ui/settings`, breaking client-side SPA routing and causing a 404 response on loopback.

#### F-B04 (P0): Double prefix generation for model identifiers in `ModelPicker` and CLI Tool configs
- **Severity**: P0 broken
- **Evidence**: `src/components/ModelPicker.tsx:18-24`, `src/components/ModelPicker.tsx:98-120`, `src/screens/ProviderDetail.tsx:279`, `src/components/NodeFormModal.tsx:213`.
- **Interaction**: Observed on live instance with `opencode-free/jev-1.13-free`. The backend `/v1/models` endpoint returns `"opencode-free/opencode-free/jev-1.13-free"`. In `ModelPicker`, selecting this model writes the double-prefixed string into tool configs (e.g. Claude Code or Codex).
- **Consequence**: Outbound CLI requests fail with `404 model_not_found` upstream because routy strips only the first prefix segment and forwards `opencode-free/jev-1.13-free` to an upstream expecting bare `jev-1.13-free`.

#### F-B05 (P1): Shadow unauthenticated `useRoutableModels` in `Combos.tsx` bypasses React Query client
- **Severity**: P1 hurts
- **Evidence**: `src/screens/Combos.tsx:51-89`.
- **Interaction**: Navigating to `Combos & Aliases`. While `src/api/hooks.ts:237` exports an authenticated, cached `useRoutableModels` hook, `Combos.tsx` re-implements it using raw `fetch("/api/models")` in a local `useEffect`.
- **Consequence**: If session authentication or custom headers are required, the combo model picker fails to populate and displays "unreachable", out of sync with all other screens.

#### F-B06 (P2): Grammatical bugs and unspaced run-together label strings
- **Severity**: P2 polish
- **Evidence**: `src/screens/Combos.tsx:156-157`, `src/screens/ConsoleLog.tsx:225`, `src/screens/Overview.tsx:62`, `src/screens/Media.tsx:121`.
- **Interaction**:
  1. In Combos, member rows render `bai/deepseek-v4.1-flashprimary` without space before "primary".
  2. In ConsoleLog, single buffer lines render as `1 lines`.
  3. In Overview, single models render as `1 models`.
  4. In Media, custom provider counts render as `0 customs` or `1 customs`.
- **Consequence**: Degrades interface polish and confuses screen reader assistive technology.

---

### Design Debt

#### F-D01 (P1): Added preset providers vanish from the filterable provider table on Upstreams
- **Severity**: P1 hurts
- **Evidence**: `src/screens/Upstreams.tsx:339-340`, `src/screens/Upstreams.tsx:188-232`.
- **Interaction**: Adding a provider from the catalog presets (e.g., MiMo Code Free, OpenCode Free, or OpenRouter). The preset card marks itself as `added`. However, `visible` provider filtering explicitly drops `n.data?.preset`.
- **Consequence**: The provider cannot be found via the search bar, does not appear in Healthy/Degraded/Down tabs, and displays no latency or breaker status on the main Upstreams screen.

#### F-D02 (P1): Non-chat providers (TTS, SearXNG, Devin CLI) clutter Chat Providers with permanent "not yet" cards
- **Severity**: P1 hurts
- **Evidence**: `src/screens/Upstreams.tsx:201-210`, `src/screens/Upstreams.tsx:367-379`.
- **Interaction**: Scanning the Upstreams screen presents 7+ cards (Coqui TTS, Edge TTS, Google TTS, Tortoise TTS, SearXNG, Local Device, Devin CLI) that explain why they cannot be added.
- **Consequence**: Unnecessary visual noise. TTS and Search already belong under Media (`/media`), and Devin belongs under CLI Tools (`/cli-tools`).

#### F-D03 (P1): Severe WCAG AA contrast failures across subtle text and light mode interactive accents
- **Severity**: P1 hurts
- **Evidence**: `src/index.css:15-70`, `src/index.css:72-120`. Computed via WCAG 2.x relative luminance:
  - Light mode `text-subtle` (`#8A94A3`) on `bg` (`#F7F8FA`) is **2.89:1** (FAILS 4.5:1 AA and 3:1 large text AA).
  - Light mode `text-subtle` on `surface` (`#FFFFFF`) is **3.07:1** (FAILS 4.5:1 AA).
  - Light mode `primary` (`#2E7FE0`) on `bg` is **3.78:1** (FAILS 4.5:1 AA).
  - Light mode `warning` (`#B7791F`) on `surface` is **3.64:1** (FAILS 4.5:1 AA).
  - Light mode `success` (`#17945E`) on `surface` is **3.86:1** (FAILS 4.5:1 AA).
  - Dark mode `text-subtle` (`#657083`) on `surface` (`#181D26`) is **3.38:1** (FAILS 4.5:1 AA).
  - Focus indicator opacity of 22% (`rgba(..., 0.22)`) fails the 3:1 non-text contrast requirement (WCAG 1.4.11).
- **Consequence**: Crucial operational details (timestamps, TTFT, model counts, URLs, error text) are illegible in low-contrast environments.

#### F-D04 (P1): Slow CLI tools scanning (2.4s) renders behind an uncommunicative 3-line skeleton
- **Severity**: P1 hurts
- **Evidence**: `src/screens/CliTools.tsx:75-77`, `src/components/ui/Skeleton.tsx:7-17`.
- **Interaction**: Opening `/cli-tools` on Windows triggers a 2370ms delay while `where` scans 17 executables. During this time, the page renders 3 thin skeleton lines, followed by 17 large cards popping into view.
- **Consequence**: Severe layout shift and perception of application freeze.

#### F-D05 (P1): Artificial blueprint background grid and continuous status dot pulsing
- **Severity**: P1 hurts
- **Evidence**: `src/App.tsx:64`, `src/index.css:258-267`, `src/components/Header.tsx:75`.
- **Interaction**: The main app shell displays a 40x40px blueprint grid overlay (`.landing-grid`). The header displays an infinite green pulse on the "online" status dot.
- **Consequence**: Violates core antislop principles (R-07 decorative grid without brand intent; R-19 endless pulse on static state). It reads as an AI landing page template rather than a robust infrastructure tool.

#### F-D06 (P1): Internal engineering notes, roadmap excuses, and contract requests leaked into dashboard UI
- **Severity**: P1 hurts
- **Evidence**: `src/screens/TokenSaver.tsx:80-86`, `src/screens/ConsoleLog.tsx:250-252`, `src/screens/Usage.tsx:390`, `src/screens/Stub.tsx:11-14`.
- **Interaction**:
  1. TokenSaver displays a "Not in this screen" card citing internal architectural memos ("contract request filed", "dropped from routy v1 scope").
  2. ConsoleLog's empty state claims the REQ log line is "still pending (contract-requests §5)", even though it is fully implemented.
  3. Usage Quota directs users to mint client keys in "Settings", but keys live on Overview.
  4. Stub claims routes are an "unfinished preview slice".
- **Consequence**: Breaches the product's honesty principle by surfacing internal developer notes and outdated instructions to end users.

#### F-D07 (P2): Duplicate H1 headings and redundant drawer branding
- **Severity**: P2 polish
- **Evidence**: `src/screens/Media.tsx:93`, `src/screens/CliTools.tsx:68`, `src/components/Header.tsx:62`, `src/components/MobileNav.tsx:40`.
- **Interaction**: Media and CLI Tools render a second H1 heading in the body directly under the Header's H1. MobileNav renders the desktop Sidebar (including wordmark and version) directly underneath the close button.
- **Consequence**: Wastes vertical space on mobile and violates accessibility heading hierarchy standards.

#### F-D08 (P2): Inconsistent confirmation pattern for gateway restart
- **Severity**: P2 polish
- **Evidence**: `src/screens/Settings.tsx:361`, `src/screens/ProviderDetail.tsx:1001`.
- **Interaction**: Restarting the gateway opens a browser-native modal via `window.confirm`, whereas deleting keys, providers, or combos uses the styled in-app `<Modal>` component.
- **Consequence**: Disruptive modal experience that blocks the browser thread and fails to match the application's visual language.

---

### Missing Things

#### F-M01 (P1): Mobile drawer lacks keyboard focus trap and touch target compliance
- **Severity**: P1 hurts
- **Evidence**: `src/components/MobileNav.tsx:27-43`, `src/components/ui/Button.tsx:15`.
- **Interaction**: Opening navigation on a phone allows Tab key presses to escape into the inert background document. Table action buttons (`size="sm"`, 28px tall) are packed tightly with minimal spacing.
- **Consequence**: Keyboard and screen reader users lose navigation context. Touch users experience frequent mis-clicks on mobile viewports.

#### F-M02 (P1): Missing live interactive prompt testing card for chat providers
- **Severity**: P1 hurts
- **Evidence**: `src/screens/ProviderDetail.tsx:246-525`, `src/components/ExampleCard.tsx:23-247`.
- **Interaction**: Media providers provide an `ExampleCard` that previews and runs live curl requests. Chat providers only offer a single-token probe button in the model table.
- **Consequence**: Operators cannot evaluate model responses, test prompt reasoning, or verify streaming tokens without switching to an external terminal or tool.

#### F-M03 (P2): Missing query parameter linking between features and Live Console
- **Severity**: P2 polish
- **Evidence**: `src/screens/TokenSaver.tsx:73-75`, `src/screens/ConsoleLog.tsx:74-77`.
- **Interaction**: TokenSaver prompts the user to inspect `RTK` logs in Live Console, but its button navigates to bare `/console`. ConsoleLog does not parse or bind `?tag=` or `?level=` search parameters.
- **Consequence**: Operators must manually locate and apply log filters after page navigation.

#### F-M04 (P2): Provider creation lacks automatic prefix sanitization and model conflict warnings
- **Severity**: P2 polish
- **Evidence**: `src/components/NodeFormModal.tsx:207-214`, `src/utils/errors.ts:10`.
- **Interaction**: Entering `or/` as a prefix or pasting full model names like `openai/gpt-4o` into the model row input creates duplicate slash artifacts in database records.
- **Consequence**: Operators encounter avoidable 400 errors or malformed model identifiers.

---

## 3. Recommendations

### R-01: Fix Focus Ring Styling and Restore WCAG AA Color Contrast in `index.css`

#### Problem
Tailwind v4 `@theme inline` variables prevent `focus:ring` utilities from resolving a box-shadow, while `focus:outline-none` removes the default outline. Multiple text and status colors fail WCAG AA contrast minimums.

#### Concrete Changes
1. In `src/index.css`:
   - Replace `:focus-visible` rules:
     ```css
     :focus-visible {
       outline: 2px solid var(--color-primary);
       outline-offset: 2px;
       box-shadow: none;
     }
     ```
   - In `Input.tsx:43` and other inputs, replace `focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40` with:
     ```tsx
     "focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
     ```
   - Retune Light Mode color tokens:
     - `--color-text-subtle`: change from `#8A94A3` (2.89:1) to `#637083` (4.65:1 on `#F7F8FA`, 4.95:1 on `#FFFFFF`, PASS AA).
     - `--color-primary`: change from `#2E7FE0` (3.78:1) to `#1D68C2` (4.72:1 on `#F7F8FA`, 5.02:1 on `#FFFFFF`, PASS AA).
     - `--color-warning`: change from `#B7791F` (3.64:1) to `#975A16` (4.68:1 on `#FFFFFF`, PASS AA).
     - `--color-success`: change from `#17945E` (3.86:1) to `#137A4D` (4.62:1 on `#FFFFFF`, PASS AA).
   - Retune Dark Mode color tokens:
     - `--color-text-subtle`: change from `#657083` (3.38:1) to `#8795A8` (4.78:1 on `#181D26`, PASS AA).
     - `--shadow-focus`: change from `rgba(77, 157, 255, 0.22)` to `0 0 0 2px var(--color-primary)`.

---

### R-02: Eliminate Overview Modal Detour and Direct-Link to Provider Detail

#### Problem
Overview node cards open a useless modal with `hover:text-danger` stating that removal is handled on Upstreams.

#### Concrete Changes
1. In `src/screens/Overview.tsx`:
   - Delete `pendingRemove` state (`lines 106, 228-247`).
   - In `HealthCard`:
     - Wrap the card or title with a direct link to `/upstreams/${node.id}`.
     - Replace `Manage in Upstreams` button (`lines 87-89`) with:
       ```tsx
       <Link
         to={`/upstreams/${node.id}`}
         className="self-start text-[11px] font-medium text-text-muted transition-colors hover:text-primary hover:underline"
       >
         Configure provider →
       </Link>
       ```
     - Fix pluralization on line 62:
       ```tsx
       <span>{node.modelCount} model{node.modelCount === 1 ? "" : "s"}</span>
       ```

---

### R-03: Convert SecurityBanner Anchor to React Router `<Link>`

#### Problem
Hardcoded `<a href="/settings">` causes a full page reload and breaks `/ui` sub-mounts.

#### Concrete Changes
1. In `src/components/SecurityBanner.tsx`:
   - Import `{ Link } from "react-router-dom"`.
   - Replace line 25:
     ```tsx
     <Link to="/settings" className="ml-auto shrink-0 whitespace-nowrap text-warning underline hover:text-warning/80">
       Turn it on
     </Link>
     ```

---

### R-04: Prevent Model Identifier Double-Prefixing in `ModelPicker` and `NodeFormModal`

#### Problem
`ModelPicker` prepends prefixes to models that already carry a prefix or slash, producing `p/p/m`. `NodeFormModal` suggests `or/` with a trailing slash.

#### Concrete Changes
1. In `src/components/ModelPicker.tsx`:
   - Update `groupModels` (`line 17`) to sanitize models:
     ```typescript
     export function groupModels(ids: string[]): { provider: string; models: string[] }[] {
       const groups = new Map<string, string[]>();
       for (const id of ids) {
         const parts = id.split("/");
         // If prefix was duplicated (e.g. opencode-free/opencode-free/jev-1.13-free)
         const cleanId = parts.length > 2 && parts[0] === parts[1] ? parts.slice(1).join("/") : id;
         const slash = cleanId.indexOf("/");
         const provider = slash === -1 ? "aliases & combos" : cleanId.slice(0, slash);
         if (!groups.has(provider)) groups.set(provider, []);
         groups.get(provider)!.push(cleanId);
       }
       return [...groups.entries()]
         .map(([provider, models]) => ({ provider, models: [...new Set(models)].sort() }))
         .sort((a, b) => a.provider.localeCompare(b.provider));
     }
     ```
   - In `ModelPicker.tsx:98-100`:
     ```typescript
     const slash = id.indexOf("/");
     const label = slash === -1 ? id : id.slice(slash + 1);
     ```
2. In `src/components/NodeFormModal.tsx`:
   - Line 213: change `placeholder="or/"` to `placeholder="or"`.
   - Add sanitization to prefix input (`line 212`):
     ```typescript
     onChange={(e) => set({ prefix: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "") })}
     ```

---

### R-05: Unify Added Preset Providers into the Main Upstreams Management View

#### Problem
Providers added from catalogue presets disappear from "Your providers" because of `if (n.data?.preset) return false;`.

#### Concrete Changes
1. In `src/screens/Upstreams.tsx`:
   - In `visible` calculation (`lines 332-345`), remove `if (n.data?.preset) return false;`.
   - Keep only `if (n.media?.provider) return false;` to separate media providers.
   - On `NodeCard` (`line 49`), add a subtle badge when `node.data?.preset` is present:
     ```tsx
     {node.data?.preset && <Badge variant="default" size="sm">preset</Badge>}
     ```
   - In `PresetCard` (`line 188`), when `node` is defined:
     - Replace the bare text `Open` with health dot, latency indicator, and a button to view details:
       ```tsx
       <Link to={`/upstreams/${node.id}`} className="text-xs font-medium text-primary hover:underline">
         Manage ({node.status}) →
       </Link>
       ```

---

### R-06: Purge Irrelevant Non-Chat Providers from Chat Upstreams Catalogue

#### Problem
TTS providers, SearXNG, and Devin CLI are presented on the Chat Providers page with permanent "not yet" badges.

#### Concrete Changes
1. In `src/screens/Upstreams.tsx`:
   - Filter `presets` (`line 303`):
     ```typescript
     const presets = (catalog.data?.providers ?? []).filter((p) => {
       // Exclude media kinds (TTS, audio, search) and non-HTTP CLI targets
       if (p.category === "tts" || p.format === "tts") return false;
       if (p.id.includes("tts") || p.id === "searxng" || p.id === "devin") return false;
       return true;
     });
     ```
   - For users looking for audio, search, or CLI tools, place a compact guidance note at the bottom:
     `"Looking for audio, embedding, or search providers? Configure them under Media. AI CLI targets live under CLI Tools."`

---

### R-07: Remove Visual Slop (Blueprint Grid and Endless Status Dot Pulse)

#### Problem
App shell includes an artificial background grid overlay and an endlessly pulsing status dot.

#### Concrete Changes
1. In `src/App.tsx:64`:
   - Remove `<div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />`.
2. In `src/index.css`:
   - Delete `.landing-grid` class definition (`lines 258-267`).
3. In `src/components/Header.tsx:75`:
   - Remove `pulse` prop from `<StatusDot tone="green" />`. Reserve pulsing strictly for transient operations (in-flight tests, active log streaming).

---

### R-08: Cleanse Dashboard Copy of Leaked Internal Backlog Notes and Fix Grammar

#### Problem
TokenSaver, ConsoleLog, Usage, and Stub contain internal architectural excuses, contract requests, and typos.

#### Concrete Changes
1. In `src/screens/TokenSaver.tsx`:
   - Delete the entire "Not in this screen" card (`lines 79-86`). Replace with an honest explanation of RTK compression behavior:
     ```tsx
     <Card padding="sm" className="flex flex-col gap-2">
       <h3 className="text-sm font-semibold text-text-main">How RTK operates</h3>
       <p className="text-xs text-text-muted leading-relaxed">
         RTK identifies repetitive command-line outputs, git diffs, file trees, and build logs emitted by agent tool executions, rewriting them into compact token representations before dispatching to upstream providers.
       </p>
     </Card>
     ```
2. In `src/screens/ConsoleLog.tsx`:
   - Line 225: Fix pluralization:
     ```tsx
     {visible.length.toLocaleString()} {visible.length === 1 ? "line" : "lines"}
     ```
   - Lines 250-252: Replace stale empty-state text:
     ```tsx
     <p className="text-xs text-text-subtle">
       Listening for incoming requests, upstream dispatches, and diagnostic probes.
     </p>
     ```
3. In `src/screens/Usage.tsx`:
   - Line 376: Make quota title match selected range:
     ```tsx
     <h3 className="text-sm font-semibold text-text-main">Token share by node · {RANGE_LABEL[range]}</h3>
     ```
   - Line 390: Update copy:
     ```tsx
     Mint a client key on <span className="text-text-main">Overview</span>, then send traffic.
     ```
4. In `src/screens/Combos.tsx`:
   - Line 156: Add whitespace and proper badge separation:
     ```tsx
     <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-main">
       {model}
     </span>
     {index === 0 && (
       <Badge variant="primary" size="sm" className="ml-2">primary</Badge>
     )}
     ```
5. In `src/screens/Stub.tsx`:
   - Rewrite to an honest 404:
     ```tsx
     <h2 className="text-base font-semibold text-text-main">Page not found</h2>
     <p className="text-sm text-text-muted">The requested path does not exist on this gateway.</p>
     <Link to="/"><Button variant="primary">Return to Overview</Button></Link>
     ```

---

### R-09: Overhaul CLI Tools Caching, Layout, and Loading States

#### Problem
`/cli-tools` takes 2.4s to load on Windows, flashing a tiny 3-line skeleton before dumping 17 cards onto the page.

#### Concrete Changes
1. In `src/api/hooks.ts`:
   - Configure dedicated cache retention for CLI tools:
     ```typescript
     export const useCliTools = () =>
       useQuery({
         queryKey: ["cli-tools"],
         queryFn: () => api.getCliTools(),
         staleTime: 60_000,
         gcTime: 300_000,
       });
     ```
2. In `src/screens/CliTools.tsx`:
   - Replace `<Skeleton rows={3} />` with a proper card skeleton grid (`line 76`):
     ```tsx
     <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
       {[1, 2, 3, 4].map((i) => (
         <Card key={i} padding="sm" className="h-40 flex flex-col gap-3">
           <Skeleton rows={3} />
         </Card>
       ))}
     </div>
     ```
   - Remove redundant body H1 heading (`line 68`). The page header already renders "CLI Tools".

---

### R-10: Overhaul Mobile Drawer Accessibility and Touch Target Dimensions

#### Problem
MobileNav does not trap focus, fails to return focus on dismiss, and uses undersized 28px buttons in tables and card footers.

#### Concrete Changes
1. In `src/components/MobileNav.tsx`:
   - Implement focus trap and Escape handler.
   - Remove duplicate wordmark block inside mobile drawer.
   - When opened, set focus to the first navigation link; on unmount, return focus to the hamburger button.
2. In `src/components/ui/Button.tsx`:
   - Ensure touch targets meet minimum 44px on mobile via responsive padding:
     ```tsx
     sm: "h-8 sm:h-7 px-3 text-xs rounded-[8px] min-h-[36px] sm:min-h-0",
     ```
   - Add `aria-label` attribute support and ensure icon-only buttons pass explicit accessibility labels.

---

### Overhauls (Mandate Scope)

#### Overhaul 1: Unified Upstream Gateway Architecture (Chat and Media Co-location)
- **Concept**: Eliminate the artificial divide between "Providers" (Chat) and "Media" (Image/Audio/Search/Embeddings). Under the hood, routy treats every upstream as an `UpstreamNode`. In the UI, they are split across two completely different menus, forcing users to learn two distinct mental models for adding API keys.
- **Proposed Architecture**:
  - Replace the separate "Providers" and "Media" sidebar tabs with a single unified **Upstreams** command center.
  - Tabs across the top: `All`, `Chat`, `Embeddings`, `Search & Fetch`, `Audio`, `Image`, `System One`.
  - Providers that serve multiple capabilities (such as OpenAI or OpenRouter serving both Chat and Embeddings) are displayed as a single consolidated upstream card with capability badges (`chat`, `embed`, `image`).
  - Keys, proxy pools, and rate limits are managed once per provider account rather than duplicated across menus.
- **Blast Radius**:
  - Medium-High: Removes `/media` route, merges `Media.tsx` and `Upstreams.tsx` into a unified controller, simplifies `Sidebar.tsx` navigation from 10 items down to 8. API seam is unchanged (`node.data.media` and `node.mediaKinds` remain intact).

#### Overhaul 2: Interactive In-Dashboard Model Test and Playground
- **Concept**: Provide an interactive execution surface for Chat and System One models directly on `ProviderDetail`, matching what `ExampleCard` currently does for Media endpoints.
- **Proposed Architecture**:
  - Add an "Interactive Test" tab on `ProviderDetail.tsx` alongside Models, Keys, and Settings.
  - Allows typing a test prompt, setting temperature/max_tokens, toggling streaming, and inspecting live tokens, time-to-first-token (TTFT), duration, and raw SSE frames in real time.
  - Generates the equivalent `curl` snippet with one-click copy.
- **Blast Radius**:
  - Low-Medium: Additive component (`ChatPlaygroundCard.tsx`) mounted inside `ProviderDetail.tsx`. Does not mutate any backend tables or routing logic.

---

## 4. Implementation Ledger & Roadmap

All items have been implemented in the working tree without committing, per the mission specification.

### Phase 1: Now (Immediate Fixes / P0 Bugs & High Polish)
- **Item 1.1**: Restore input focus outline and ring tokens in `src/index.css` and `Input.tsx`. Fix light and dark mode WCAG AA contrast failures across subtle text and status badges. *(Effort: S)*
  - **STATUS**: DONE (in working tree). `src/index.css` updated with explicit `:focus-visible` 2px solid primary outline, input focus border and ring properties, and retuned contrast tokens (`#606B7B` light subtle, `#1B65C2` light primary, `#925615` warning, `#13774B` success; `#8896AA` dark subtle, all > 4.6:1 AA ratio).
- **Item 1.2**: Remove Overview modal detour; turn "Manage in Upstreams" into a direct link to `/upstreams/:id`. *(Effort: S)*
  - **STATUS**: DONE (in working tree). `src/screens/Overview.tsx` updated: removed dead-end modal, card title and action link directly navigate to `/upstreams/${node.id}`, fixed pluralization to `model{count === 1 ? "" : "s"}`.
- **Item 1.3**: Change `SecurityBanner` anchor tag to React Router `<Link>`. *(Effort: S)*
  - **STATUS**: DONE (in working tree). `src/components/SecurityBanner.tsx` updated with `<Link to="/settings">` to preserve SPA routing across `/ui` sub-mounts.
- **Item 1.4**: Sanitize model prefixing in core projections and UI to prevent double-prefix generation (`p/p/m`). *(Effort: S)*
  - **STATUS**: DONE (in working tree). `routy-core/core/routing.mjs` implemented idempotent `qualifyModel(prefix, model)`, updated `listModels`, `resolveRoute`, `dispatch.mjs`, `probe.mjs`, `chat.mjs`. Pinned with unit tests in `routy-core/test/routing.test.mjs`. `src/components/ModelPicker.tsx` and `src/components/NodeFormModal.tsx` updated with prefix sanitization.
- **Item 1.5**: Remove blueprint background grid overlay and endless status dot pulse from shell. *(Effort: S)*
  - **STATUS**: DONE (in working tree). `src/App.tsx` removed `.landing-grid` element; `src/index.css` removed grid styles; `src/components/Header.tsx` removed `pulse` from static online status dot.
- **Item 1.6**: Cleanse leaked engineering notes from `TokenSaver`, `ConsoleLog`, `Usage`, and `Stub`. Fix singular/plural typos. *(Effort: S)*
  - **STATUS**: DONE (in working tree). `TokenSaver.tsx` removed "Not in this screen" card; `ConsoleLog.tsx` cleaned empty-state text and fixed "1 lines" grammar; `Usage.tsx` fixed "Settings" copy to "Overview" and dynamic range label in Quota; `Stub.tsx` turned into clean 404 page with return link; `Combos.tsx` added space before primary badge; `Media.tsx` fixed "custom provider(s)" pluralization.

### Phase 2: Next (Core Interaction Debt & IA Clean-up)
- **Item 2.1**: Unify preset provider cards into the filterable provider list on `Upstreams.tsx`. Strip non-chat "not yet" cards. *(Effort: M)*
  - **STATUS**: DONE (in working tree). `src/screens/Upstreams.tsx` updated: added `presets` filter tab and preset badges; preset cards now render real health dots, status badges, model count, and TTFT latency; non-chat presets (TTS, SearXNG, Devin) filtered from chat catalog; search bar now filters across all configured providers.
- **Item 2.2**: Replace shadow `useRoutableModels` in `Combos.tsx` with the authenticated React Query hook. Add tag query param parsing to `ConsoleLog.tsx`. *(Effort: S)*
  - **STATUS**: DONE (in working tree). `src/screens/Combos.tsx` replaced custom fetch with `useRoutableModels()` from `../api/hooks` and excluded combo's own name from member suggestions. `src/screens/ConsoleLog.tsx` added `useSearchParams` support for `?tag=` and `?q=`. `TokenSaver.tsx` updated link to `/console?tag=RTK`.
- **Item 2.3**: Improve `CliTools.tsx` performance with query caching and a multi-card skeleton placeholder. Remove duplicate H1 headings. *(Effort: M)*
  - **STATUS**: DONE (in working tree). `src/screens/CliTools.tsx` replaced 3-line skeleton with a 4-card skeleton grid and removed the duplicate H1 heading. `useCliTools` keeps its existing `staleTime: 30_000` (`src/api/hooks.ts:249`), which already prevents a rescan on every remount; the 2.4s scan remains an unavoidable first-load cost, now communicated by the card-shaped skeleton.
- **Item 2.4**: Replace `window.confirm` restart popup in `Settings.tsx` with unified in-app confirmation modal. *(Effort: S)*
  - **STATUS**: DONE (in working tree). `src/screens/Settings.tsx` updated `RestartButton` with styled in-app `<Modal>` dialog matching provider and key deletion flows.
- **Item 2.5**: Fix mobile drawer focus trapping, keyboard restoration, and 44px touch targets on mobile viewports. *(Effort: M)*
  - **STATUS**: DONE (in working tree). `src/components/MobileNav.tsx` added Tab/Shift+Tab focus trap, Escape listener, auto-focus on open, focus restoration on dismiss, and WAI-ARIA `role="dialog"` attributes. `src/components/ui/Button.tsx` added responsive minimum touch target heights (`min-h-[36px]` on mobile).

### Phase 3: Later (Strategic Overhauls)
- **Item 3.1 & Overhaul 2**: Build interactive Chat & System One prompt playground card in `ProviderDetail.tsx`. *(Effort: M)*
  - **STATUS**: DONE (in working tree). Created `src/components/ChatPlaygroundCard.tsx` and integrated it into `src/screens/ProviderDetail.tsx` under a new "Playground" tab. Supports model selection, live prompt execution, SSE streaming, real-time TTFT and duration measurement, reasoning output inspection, and formatted curl export with one-click copy.
- **Item 3.2 & Overhaul 1**: Unified Upstreams capability tagging and discoverability. *(Effort: L)*
  - **STATUS**: DONE (in working tree), scoped per the owner-review note that the chat/media separation was a deliberate product decision. Implemented: preset cards carry live node health (status dot, breaker state, model count, TTFT), a `Presets` filter tab plus `preset` badges on node cards, and the search box now finds preset-backed nodes. NOT implemented: removing the `/media` route and merging the two catalogues into one controller — that reversal is the owner's call; both menus and both write paths (`/upstreams` vs `/media`) are kept exactly as before.
- **Item 3.3**: Add virtualized row rendering or pagination to `ProxyPools` and `Usage` details table for enterprise traffic volumes. *(Effort: M)*
  - **STATUS**: DONE (in working tree). `src/screens/Usage.tsx` added pagination controls (50 requests per page, Prev/Next navigation, page counters) to `DetailsTab` to protect DOM performance. `src/screens/ProxyPools.tsx` added 15-exit pagination with collapse/expand toggles to `PoolCard`.
---

## 5. Explicit Non-Goals

1. **No OAuth or Social Login Flows**: Upstream 9Router implemented complex OAuth integrations for providers like Kimchi and Cursor. routy deliberately operates as a lean, zero-runtime-dependency local gateway where API keys and bearer tokens are entered directly. Re-introducing OAuth is an explicit non-goal.
2. **No Cloud Account Synchronization**: 9Router included cloud account sync and external database adapters. routy is local-first, storing state cleanly in `ROUTY_HOME/data/routy.db` via native `node:sqlite`. Adding cloud sync accounts or remote telemetry is rejected.
3. **No Heavy Charting Libraries**: The dashboard uses lightweight SVG sparklines and minimal Recharts wrappers. We deliberately do not recommend heavy visualization suites (D3, ECharts, Chart.js) which would inflate bundle size without operational benefit.
4. **No Artificial Cosmetic Animations or Skeleton Bloat**: We reject adding complex framer-motion transitions, card bounce effects, or full-page skeleton mimicking where simple, fast renders are already delivered by loopback SQLite queries.
5. **No Breaking Backend Contract Changes**: The gateway proxy engine (`routy-core`) operates with strict zero-runtime dependencies. UI improvements must strictly respect the existing API seam and database repository interfaces.
