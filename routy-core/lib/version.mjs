// The version has exactly one source of truth: routy-core/package.json.
//
// A bundled release cannot read package.json — there is no source tree next to the
// single file — so the build inlines the value with esbuild's `define`. Running from
// a checkout reads the file instead.
//
// `typeof` is deliberate: an undeclared identifier is only safe to mention in that
// position, which is what lets the same line work both inlined and not.
import fs from "node:fs";

// __ROUTY_VERSION__ is a free identifier: scripts/build.mjs replaces it with a
// string literal at bundle time. Left undeclared on purpose.
function fromPackageJson() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

export const VERSION = (() => {
  if (typeof __ROUTY_VERSION__ !== "undefined") return __ROUTY_VERSION__;
  return fromPackageJson() ?? "0.0.0-dev";
})();

/**
 * Compare two semver strings. Returns -1, 0 or 1.
 *
 * Deliberately not a string compare: "0.10.0" > "0.9.0" numerically but sorts
 * before it lexically, and an updater that gets that backwards either misses
 * releases or offers a downgrade. Pre-release suffixes order below their release
 * (1.0.0-rc.1 < 1.0.0), which is what `npm version` produces.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ""] = String(v).replace(/^v/, "").split("-", 2);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // a release outranks its own pre-releases
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/** True when `candidate` is a strictly newer version than `current`. */
export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;
