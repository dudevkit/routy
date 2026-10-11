// Bounded in-memory login-flow manager for CodeBuddy Intl OAuth.
//
// One process-local Map keyed by a cryptographically random 256-bit flow id. It holds
// only what a login needs while it is pending: the upstream polling state, the intent,
// the expiry, and a sanitized terminal result. Upstream state never reaches the DB or
// the browser; tokens live only long enough to be committed.
//
// The hard part is arbitration between a poll that is about to commit and a cancel or
// expiry that arrives while that poll is in flight. Node is single-threaded, so the
// transition between phases is synchronous — but the upstream poll awaits, and a
// cancel can land in that window. The rule:
//
//   · while phase === "polling", cancel/expiry wins by moving the flow to a terminal
//     phase; the poll then re-checks the phase after its await and DISCARDS the tokens
//     instead of committing;
//   · the poll atomically moves the flow to "committing" immediately before running the
//     synchronous repository transaction; once that has happened, commit wins and a
//     concurrent cancel reports the sanitized completed result rather than claiming it
//     cancelled.
//
// `commit` is a SYNCHRONOUS function (the repository writes are synchronous), so the
// committing phase contains no await and nothing can interleave inside it.

import crypto from "node:crypto";

export const MAX_FLOWS = 20;
export const FLOW_TTL_MS = 10 * 60_000;
export const MIN_POLL_INTERVAL_MS = 4000;
export const TERMINAL_RETENTION_MS = 2 * 60_000;

const TERMINAL = new Set(["complete", "cancelled", "expired", "failed"]);

export class FlowLimitError extends Error {
  constructor() { super("too many login flows in progress"); this.code = "too_many_flows"; }
}
export class FlowNotFoundError extends Error {
  constructor() { super("login flow not found"); this.code = "flow_not_found"; }
}
export class FlowRateError extends Error {
  constructor(retryAfterMs) { super("polling too quickly"); this.code = "poll_too_fast"; this.retryAfterMs = retryAfterMs; }
}

export function createFlowManager({ now = () => Date.now() } = {}) {
  /** @type {Map<string, object>} */
  const flows = new Map();
  let sweepTimer = null;

  function liveCount() {
    let n = 0;
    for (const f of flows.values()) if (!TERMINAL.has(f.phase)) n++;
    return n;
  }

  function sweep() {
    const t = now();
    for (const [id, f] of flows) {
      if (TERMINAL.has(f.phase)) {
        if (f.terminalAt && t - f.terminalAt > TERMINAL_RETENTION_MS) flows.delete(id);
        continue;
      }
      if (t > f.expiresAt) {
        f.phase = "expired";
        f.terminalAt = t;
        f.upstreamState = null;
        f.result = { state: "failed", error: { code: "flow_expired", message: "the login flow expired — start again" } };
      }
    }
  }

  function ensureSweeper() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, 30_000);
    sweepTimer.unref?.();
  }

  function finish(f, state, payload) {
    f.phase = state;
    f.terminalAt = now();
    f.upstreamState = null;      // never retain the polling handle past terminal
    f.result = payload;
  }

  /**
   * Create a flow. `commit(tokens)` runs synchronously at commit time and must return
   * the safe node/connection view for the terminal result. `expire` optionally cleans
   * up when the flow expires without committing.
   */
  function create({ intent, verificationUrl, upstreamState, expiresAt, pollIntervalMs = 5000, commit, onExpire = null }) {
    sweep();
    if (liveCount() >= MAX_FLOWS) throw new FlowLimitError();
    const id = crypto.randomBytes(32).toString("hex");
    const flow = {
      id, intent, verificationUrl, upstreamState,
      expiresAt: expiresAt ?? (now() + FLOW_TTL_MS),
      pollIntervalMs,
      phase: "pending",
      lastPollAt: 0,
      inflight: null,
      commit,
      onExpire,
      result: null,
      terminalAt: null,
      createdAt: now(),
    };
    flows.set(id, flow);
    ensureSweeper();
    return { flowId: id, verificationUrl, expiresAt: flow.expiresAt, pollIntervalMs };
  }

  function get(id) {
    sweep();
    return flows.get(id) || null;
  }

  /** A safe, token-free public view of a terminal (or pending) flow. */
  function publicView(f) {
    if (!f) return null;
    if (TERMINAL.has(f.phase)) {
      if (f.result) return f.result;
      if (f.phase === "expired") return { state: "failed", error: { code: "flow_expired", message: "the login flow expired — start again" } };
      if (f.phase === "cancelled") return { state: "cancelled" };
      return { state: "failed", error: { code: "flow_failed", message: "the login flow failed" } };
    }
    return { state: "pending" };
  }

  /**
   * Make at most one upstream poll for the flow. `pollUpstream(upstreamState)` is
   * async and returns `{ state: "pending" }` or `{ state: "complete", tokens }`.
   * The manager owns all phase transitions and the commit re-check.
   */
  async function poll(id, pollUpstream) {
    sweep();
    const f = flows.get(id);
    if (!f) throw new FlowNotFoundError();
    if (TERMINAL.has(f.phase)) return f.result ?? publicView(f);

    const t = now();
    if (t > f.expiresAt) {
      finish(f, "expired", { state: "failed", error: { code: "flow_expired", message: "the login flow expired — start again" } });
      return f.result;
    }
    // Server-side cadence: never issue more than one upstream poll per interval, no
    // matter what the client does. A concurrent poll is serialized behind the in-flight
    // one and simply reports pending.
    if (f.inflight) return { state: "pending" };
    const sinceLast = t - f.lastPollAt;
    if (f.lastPollAt && sinceLast < MIN_POLL_INTERVAL_MS) throw new FlowRateError(MIN_POLL_INTERVAL_MS - sinceLast);

    f.lastPollAt = t;
    f.phase = "polling";
    f.inflight = (async () => {
      let outcome;
      try {
        outcome = await pollUpstream(f.upstreamState);
      } catch (err) {
        // A terminal upstream error fails the flow; a transient one returns to pending.
        if (err?.transient) {
          if (f.phase === "polling") f.phase = "pending";
          return { state: "pending" };
        }
        if (f.phase === "polling") {
          finish(f, "failed", { state: "failed", error: { code: err?.code || "upstream_error", message: err?.message || "the provider refused the login" } });
        }
        return f.result;
      }

      // Cancellation/expiry may have won while we awaited. If so, discard the tokens.
      if (f.phase !== "polling") return f.result ?? publicView(f);

      if (!outcome || outcome.state !== "complete") {
        f.phase = "pending";
        return { state: "pending" };
      }

      // Atomic move to committing, then the synchronous commit. Nothing awaits inside.
      f.phase = "committing";
      try {
        const safe = f.commit(outcome.tokens, f.intent);
        finish(f, "complete", { state: "complete", ...safe });
      } catch (err) {
        finish(f, "failed", { state: "failed", error: { code: err?.code || "commit_failed", message: err?.message || "could not save the account" } });
      }
      return f.result;
    })();

    try {
      return await f.inflight;
    } finally {
      f.inflight = null;
    }
  }

  /**
   * Cancel a pending flow. Returns the sanitized terminal result.
   * If a commit has already begun (or finished), the completed result is returned
   * instead of a false cancellation.
   */
  function cancel(id) {
    sweep();
    const f = flows.get(id);
    if (!f) throw new FlowNotFoundError();
    if (f.phase === "complete" || f.phase === "committing") return f.result ?? { state: "complete" };
    if (TERMINAL.has(f.phase)) return f.result ?? publicView(f);
    finish(f, "cancelled", { state: "cancelled" });
    try { f.onExpire?.(f.intent); } catch { /* cleanup is best-effort */ }
    return f.result;
  }

  /** Stop the sweep timer (tests). */
  function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  return { create, get, poll, cancel, publicView, stop, _flows: flows };
}
