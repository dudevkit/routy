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
 *
 * teardownTimeout is the worker's RPC watchdog, and the default 10s is a CPU-bound
 * assumption this suite does not meet. Closing a worker means closing sqlite handles,
 * removing temp directories and closing the sockets its proxies held — and on a box also
 * running a gateway and a browser, that can take longer than 10s while every test has
 * already passed. Vitest then reports "Timeout calling onTaskUpdate" as an unhandled
 * error and exits non-zero, so a green suite looked broken. 30s of slack costs nothing
 * when teardown is quick and removes a signal that was never about the code.
 */
export default defineConfig({
  test: {
    maxWorkers: 8,
    minWorkers: 1,
    teardownTimeout: 30_000,
    // --expose-gc so a test can measure RETAINED memory instead of whatever the
    // collector had not yet reclaimed. The bounded-buffer test asserts that a 2MB
    // stream is not retained; sampling `heapUsed` without collecting first made it a
    // coin flip — identical code measured 7.6MB and 61MB against the same 50MB
    // threshold, because the delta included garbage. With a forced collection before
    // each sample the same test measures 7.6MB in both cases, which is the number it
    // was always trying to read.
    poolOptions: { forks: { execArgv: ["--expose-gc"] } },
  },
});
