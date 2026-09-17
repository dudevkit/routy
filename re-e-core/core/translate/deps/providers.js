// deps shim — translator uses PROVIDERS[provider]?.quirks?.* only (optional-chained).
// v1 targets (openai/anthropic compatible) have no quirks; empty object = safe fallback.
export const PROVIDERS = {};
