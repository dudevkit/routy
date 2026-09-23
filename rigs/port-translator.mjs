// P1.6 — port open-sse/translator into re-e-core/core/translate verbatim,
// with a deps/ layer for external modules (ported or stubbed, each documented).
import fs from "node:fs";
import path from "node:path";

const R9 = path.resolve("9router", "open-sse");
const T_IN = path.join(R9, "translator");
const T_OUT = path.resolve("re-e-core", "core", "translate");
const DEPS = path.join(T_OUT, "deps");

fs.rmSync(T_OUT, { recursive: true, force: true });
fs.mkdirSync(DEPS, { recursive: true });

// ---------- helpers ----------
function copy(src, dest, rewrites = []) {
  let text = fs.readFileSync(src, "utf8");
  for (const [from, to] of rewrites) text = text.split(from).join(to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}

/**
 * String-aware extraction of one top-level declaration from source:
 *   extractConst(src, "NAME") for `export const NAME = <value>;`
 *   extractConst(src, "fn") for `export function fn(...) {...}`
 * Scans chars, respects ' " ` strings (incl. \` escapes and ${}), balances
 * {} () [] outside strings; const stops at top-level ';', function stops when
 * its body brace-depth returns to 0.
 */
function extractConst(source, name) {
  const re = new RegExp(`export (const|function) ${name}\\b`);
  const m = re.exec(source);
  if (!m) throw new Error(`export ${name} not found`);
  const start = m.index;
  const isFn = m[1] === "function";
  let i = isFn ? source.indexOf("{", start) : source.indexOf("=", start);
  if (i === -1) throw new Error(`body start for ${name} not found`);

  let depth = 0, str = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { str = ch; continue; }
    if (ch === "{" || ch === "(" || ch === "[") { depth++; continue; }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (isFn && ch === "}" && depth === 0) return source.slice(start, i + 1) + "\n";
      continue;
    }
    if (!isFn && ch === ";" && depth === 0) return source.slice(start, i + 1) + "\n";
  }
  throw new Error(`unterminated declaration ${name}`);
}
// ---------- 1. copy the whole translator tree verbatim ----------
function copyTree(dir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const s = path.join(dir, entry.name);
    const d = path.join(outDir, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyTree(T_IN, T_OUT);

const rewriteMap2 = [
  ['from "../../providers/index.js"', 'from "../deps/providers.js"'],
  ['from "../../utils/', 'from "../deps/'],
  ['from "../../providers/', 'from "../deps/'],
  ['from "../../config/', 'from "../deps/'],
  ['from "../../services/', 'from "../deps/'],
];
const rewriteMap1 = [
  ['from "../providers/index.js"', 'from "./deps/providers.js"'],
  ['from "../utils/', 'from "./deps/'],
  ['from "../providers/', 'from "./deps/'],
  ['from "../services/', 'from "./deps/'],
];
function walkJs(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "deps") walkJs(p, fn); continue; }
    if (entry.name.endsWith(".js")) fn(p);
  }
}
walkJs(T_OUT, (p) => {
  let text = fs.readFileSync(p, "utf8");
  const isRoot = !path.relative(T_OUT, p).includes(path.sep);
  for (const [from, to] of (isRoot ? rewriteMap1 : rewriteMap2)) text = text.split(from).join(to);
  text = text.split('from "uuid"').join(isRoot ? 'from "./deps/uuid.js"' : 'from "../deps/uuid.js"');
  // undici stays: it's an npm dep of re-e-core (SSRF DNS-pinning in image prefetch)
  // drop dead antigravity executor imports (referenced only in comments); CRLF-safe
  text = text.replace(/^import \{ AntigravityExecutor \} from "\.\.\/(executors|utils)\/antigravity\.js";\r?\n/gm, "");
  fs.writeFileSync(p, text);
});
// ---------- 3. ported dep files ----------
copy(path.join(R9, "utils/sessionManager.js"), path.join(DEPS, "sessionManager.js"), [
  ['from "../config/runtimeConfig.js"', 'from "./runtimeConfig.js"'],
]);
copy(path.join(R9, "utils/claudeSignature.js"), path.join(DEPS, "claudeSignature.js"));
copy(path.join(R9, "utils/claudeCloaking.js"), path.join(DEPS, "claudeCloaking.js"), [
  ['from "../config/appConstants.js"', 'from "./appConstants.js"'],
  ['from "../providers/shared.js"', 'from "./shared.js"'],
]);
copy(path.join(R9, "utils/streamHelpers.js"), path.join(DEPS, "streamHelpers.js"), [
  ['from "../translator/formats.js"', 'from "../formats.js"'],
]);
copy(path.join(R9, "utils/usageTracking.js"), path.join(DEPS, "usageTracking.js"), [
  ['from "../translator/formats.js"', 'from "../formats.js"'],
]);
copy(path.join(R9, "utils/kiroSessionReplay.js"), path.join(DEPS, "kiroSessionReplay.js"), [
  ['from "../config/runtimeConfig.js"', 'from "./runtimeConfig.js"'],
]);
copy(path.join(R9, "providers/capabilities.js"), path.join(DEPS, "capabilities.js"));
copy(path.join(R9, "providers/visionPatterns.js"), path.join(DEPS, "visionPatterns.js"));
copy(path.join(R9, "providers/pricing.js"), path.join(DEPS, "pricing.js"));
copy(path.join(R9, "providers/thinkingLevels.js"), path.join(DEPS, "thinkingLevels.js"), [
  ['from "../config/kiroConstants.js"', 'from "./kiroConstants.js"'],
]);
copy(path.join(R9, "config/defaultThinkingSignature.js"), path.join(DEPS, "defaultThinkingSignature.js"));
copy(path.join(R9, "config/mediaConfig.js"), path.join(DEPS, "mediaConfig.js"));
copy(path.join(R9, "config/kiroConstants.js"), path.join(DEPS, "kiroConstants.js"), [
  ['from "../translator/concerns/', 'from "../concerns/'],
]);

// ---------- 4. synthesized deps ----------
const runtimeConfigSrc = fs.readFileSync(path.join(R9, "config/runtimeConfig.js"), "utf8");
fs.writeFileSync(path.join(DEPS, "runtimeConfig.js"), [
  "// deps shim — extracted subset of upstream config/runtimeConfig.js",
  extractConst(runtimeConfigSrc, "MEMORY_CONFIG"),
  extractConst(runtimeConfigSrc, "DEFAULT_MAX_TOKENS"),
  extractConst(runtimeConfigSrc, "DEFAULT_MIN_TOKENS"),
].join("\n"));

const appConstantsSrc = fs.readFileSync(path.join(R9, "config/appConstants.js"), "utf8");
fs.writeFileSync(path.join(DEPS, "appConstants.js"), [
  "// deps shim — extracted constants from upstream config/appConstants.js",
  extractConst(appConstantsSrc, "CLAUDE_SYSTEM_PROMPT"),
  extractConst(appConstantsSrc, "CLAUDE_TOOL_SUFFIX"),
  extractConst(appConstantsSrc, "CC_DEFAULT_TOOLS"),
].join("\n"));

fs.writeFileSync(path.join(DEPS, "shared.js"), [
  "// deps shim — extracted from upstream providers/shared.js",
  'export const CLAUDE_CLI_VERSION = "2.1.258";',
  "",
].join("\n"));

const providerSrc = fs.readFileSync(path.join(R9, "services/provider.js"), "utf8");

fs.writeFileSync(path.join(DEPS, "uuid.js"), [
  "// deps shim — replaces the uuid package (builtin crypto)",
  'import crypto from "node:crypto";',
  "export const v4 = () => crypto.randomUUID();",
  "",
].join("\n"));
fs.writeFileSync(path.join(DEPS, "provider.js"), [
  "// deps shim — verbatim extract from upstream services/provider.js",
  extractConst(providerSrc, "isLastMessageFromUser"),
  extractConst(providerSrc, "normalizeThinkingConfig"),
].join("\n"));

fs.writeFileSync(path.join(DEPS, "providers.js"), [
  "// deps shim — translator uses PROVIDERS[provider]?.quirks?.* only (optional-chained).",
  "// v1 targets (openai/anthropic compatible) have no quirks; empty object = safe fallback.",
  "export const PROVIDERS = {};",
  "",
].join("\n"));

fs.writeFileSync(path.join(DEPS, "thoughtSignatureStore.js"), [
  "// deps shim — dormant gemini path (upstream persists thought signatures to kv db)",
  "export function getGeminiThoughtSignatureSync() { return null; }",
  "export function storeGeminiThoughtSignature() {}",
  "",
].join("\n"));

// ---------- 5. compile check ----------
const { execFileSync } = await import("node:child_process");
const files = [];
walkJs(T_OUT, (p) => files.push(p));
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch (e) { bad++; console.log("SYNTAX FAIL:", path.relative(T_OUT, f), "\n", String(e.stderr).split("\n")[0]); }
}
console.log(`ported: ${files.length} files (incl. deps), syntax failures: ${bad}`);
