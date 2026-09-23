// RE-E daily budget — metered spend against `settings.budgetUsdPerDay`.
//
// The counter is in memory (the hot path cannot afford a SUM per request) and is
// seeded from usage_events at boot. It rolls over at local midnight. Only metered
// nodes contribute, so an exhausted budget starves paid upstreams while free or
// local ones keep serving — the "auto-fallback to the cheaper node" behaviour.
import { isMetered } from "./pricing.mjs";

let spendUsd = 0;
let dayKey = null;

export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function seedBudget(repos, now = Date.now()) {
  dayKey = startOfDay(now);
  try {
    spendUsd = Number(repos.stats.spendSince(dayKey)?.costUsd) || 0;
  } catch {
    spendUsd = 0; // never let bookkeeping stop boot
  }
  return spendUsd;
}

export function budgetSpent(now = Date.now()) {
  const today = startOfDay(now);
  if (today !== dayKey) {
    dayKey = today;
    spendUsd = 0;
  }
  return spendUsd;
}

export function addSpend(usd) {
  if (Number.isFinite(usd) && usd > 0) spendUsd += usd;
}

export function resetBudget() {
  spendUsd = 0;
  dayKey = startOfDay();
}

/**
 * Budget state for a request. `over` is only true when a ceiling is configured
 * and metered spend has reached it.
 */
export function budgetState(budgetUsdPerDay, now = Date.now()) {
  const limit = Number(budgetUsdPerDay);
  const spent = budgetSpent(now);
  const configured = Number.isFinite(limit) && limit > 0;
  const nextDay = startOfDay(now) + 24 * 3600 * 1000;
  return {
    configured,
    limit: configured ? limit : null,
    spent,
    remaining: configured ? Math.max(0, limit - spent) : null,
    over: configured && spent >= limit,
    resetAt: configured ? nextDay : null,
    retryAfterMs: configured && spent >= limit ? Math.max(0, nextDay - now) : null,
  };
}

/** Routes a request may still use: everything, or only unmetered nodes when spent. */
export function affordableRoutes(routes, budgetUsdPerDay, now = Date.now()) {
  const state = budgetState(budgetUsdPerDay, now);
  if (!state.over) return { state, routes };
  return { state, routes: routes.filter((r) => r.kind === "node" && !isMetered(r.node)) };
}
