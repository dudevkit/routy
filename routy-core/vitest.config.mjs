import { defineConfig } from "vitest/config";

/**
 * These tests are I/O-bound, not CPU-bound: most of them create a real sqlite
 * database and a temp directory, so a pool sized to the core count (15 on a
 * 16-core box) makes every worker contend for the disk.
 *
 * The symptom is not just slowness. A migration test that takes 2s alone was
 * measured at 16s inside the full suite — 8x — and would intermittently blow its
 * budget, so the suite failed for reasons that had nothing to do with the code
 * under test. A smaller pool keeps the disk queue short.
 *
 * Measured over two runs each, 139 tests:
 *   uncapped (15 workers)  ~33s, flaky — 1 failure in 3 runs
 *   4 workers              ~43s, stable
 *   8 workers              ~34s, stable   ← this setting
 */
export default defineConfig({
  test: {
    maxWorkers: 8,
    minWorkers: 1,
  },
});
