// deps shim — extracted subset of upstream config/runtimeConfig.js
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

export const DEFAULT_MAX_TOKENS = 64000;

export const DEFAULT_MIN_TOKENS = 32000;
