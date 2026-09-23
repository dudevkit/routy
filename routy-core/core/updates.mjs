// Update detection — ask GitHub for the latest release and decide whether it is
// newer than the running build.
//
// This is the only outbound call the gateway makes that is not to a configured
// provider, so it is opt-out (`updateCheck`, default on) and cached: a user who
// turns it off sends nothing, and a user who leaves it on makes roughly four
// requests a day rather than one per page load.
//
// Nothing here ever throws. A gateway that refuses to boot, or drops a request,
// because GitHub was unreachable would be a worse bug than a missed update.
import { VERSION, isNewer } from "../lib/version.mjs";
import { fetchWithTimeout } from "../lib/net.mjs";

const DEFAULT_REPO = "dudevkit/routy";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const STATE_KEY = "updateState";

/** The cached state, shaped for the API whether or not a check has ever run. */
export function updateState(repos) {
  const enabled = repos.settings.get("updateCheck", true) !== false;
  const cached = repos.settings.get(STATE_KEY) ?? {};
  const latest = cached.latest ?? null;
  return {
    enabled,
    current: VERSION,
    latest,
    available: !!(enabled && latest && isNewer(latest, VERSION)),
    notes: cached.notes ?? null,
    publishedAt: cached.publishedAt ?? null,
    url: cached.url ?? null,
    checkedAt: cached.checkedAt ?? null,
    dismissed: repos.settings.get("updateDismissed", null),
    error: cached.error ?? null,
    // A release without the three assets cannot be applied in-app; the UI offers a
    // link to the release page instead of a button that would fail.
    assetsReady: !!(cached.tarballUrl && cached.sumsUrl && cached.sigUrl),
  };
}

/**
 * Query GitHub and cache the result. `force` skips the TTL (the dashboard's
 * "check now"); `fetchImpl` exists so tests do not need the network.
 */
export async function checkForUpdate(repos, { force = false, fetchImpl = fetch, log = null } = {}) {
  if (repos.settings.get("updateCheck", true) === false) {
    return { ...updateState(repos), enabled: false, skipped: "disabled" };
  }

  const cached = repos.settings.get(STATE_KEY) ?? {};
  // checkedAt is an ISO string for display; comparing Date.now() against it directly
  // yields NaN, which silently disables the TTL and re-asks GitHub every time.
  const checkedMs = cached.checkedAt ? Date.parse(cached.checkedAt) : 0;
  if (!force && checkedMs && Date.now() - checkedMs < CHECK_INTERVAL_MS) {
    return { ...updateState(repos), cached: true };
  }

  const repo = repos.settings.get("updateRepo", DEFAULT_REPO);
  const stamp = new Date().toISOString();
  try {
    const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl,
      headers: {
        accept: "application/vnd.github+json",
        // GitHub rejects requests without a User-Agent.
        "user-agent": `routy/${VERSION}`,
      },
    });

    if (!res.ok) {
      // 403 is the unauthenticated rate limit; 404 means no release yet.
      const note = res.status === 404 ? "no releases published yet" : `github returned ${res.status}`;
      repos.settings.update({ [STATE_KEY]: { ...cached, checkedAt: stamp, error: note } });
      return { ...updateState(repos), error: note };
    }

    const release = await res.json();
    const tag = String(release.tag_name ?? "").replace(/^v/, "");
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const assetUrl = (name) => assets.find((a) => a?.name === name)?.browser_download_url ?? null;
    const state = {
      latest: tag || null,
      notes: typeof release.body === "string" ? release.body.slice(0, 8000) : null,
      publishedAt: release.published_at ?? null,
      url: release.html_url ?? null,
      // Resolved now so the apply path never has to guess an asset name.
      tarballUrl: tag ? assetUrl(`routy-${tag}.tar.gz`) : null,
      sumsUrl: assetUrl("SHA256SUMS"),
      sigUrl: assetUrl("SHA256SUMS.sig"),
      checkedAt: stamp,
      error: tag ? null : "release has no tag",
    };
    repos.settings.update({ [STATE_KEY]: state });
    if (state.error) log?.warn?.("UPDATE", `latest release has no tag_name (${repo})`);
    else if (isNewer(tag, VERSION)) log?.info?.("UPDATE", `v${tag} available (running v${VERSION})`);
    else log?.debug?.("UPDATE", `up to date (v${VERSION})`);
    return updateState(repos);
  } catch (err) {
    const note = err?.name === "TimeoutError" ? "timed out reaching github" : `could not reach github: ${err.message}`;
    repos.settings.update({ [STATE_KEY]: { ...cached, checkedAt: stamp, error: note } });
    log?.debug?.("UPDATE", note);
    return { ...updateState(repos), error: note };
  }
}

/**
 * Check at boot, then every few hours. The timer is unref'd so it can never be the
 * reason the process stays alive during a shutdown drain.
 */
export function startUpdateChecks(repos, { log = null, fetchImpl = fetch } = {}) {
  const run = () => {
    checkForUpdate(repos, { log, fetchImpl }).catch(() => {
      /* checkForUpdate already swallows its errors; this is belt and braces */
    });
  };
  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
