/**
 * fetch with a timeout whose timer is actually cleared.
 *
 * `AbortSignal.timeout(ms)` cannot be cancelled: the timer stays pending until it
 * fires, even after the request has long finished. On Windows that leftover handle
 * is enough to trip a libuv assertion (`src\win\async.c`) when the process exits
 * shortly afterwards — observed as the gateway aborting with 0xC0000409 instead of
 * the exit code it asked for, during exactly the shutdown that an update performs.
 *
 * An explicit controller plus clearTimeout leaves nothing behind.
 */
export async function fetchWithTimeout(url, { timeoutMs, fetchImpl = fetch, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
