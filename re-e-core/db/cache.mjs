// RE-E cache — read-through with explicit invalidation on write.
// Kills upstream's per-request uncached reads (settings 2-3x/request, credentials
// per attempt). All repos invalidate on write; nothing expires by time.
export function createCacheLoader(loader) {
  let value = undefined;
  let has = false;
  return {
    get() {
      if (!has) {
        value = loader();
        has = true;
      }
      return value;
    },
    invalidate() {
      has = false;
      value = undefined;
    },
  };
}

export function createMapCache() {
  const map = new Map();
  return {
    get(key) { return map.get(key); },
    set(key, v) { map.set(key, v); },
    delete(key) { map.delete(key); },
    clear() { map.clear(); },
  };
}
