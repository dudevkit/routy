// Request lifecycle correlation: shared palettes, color indexers, and client detection.

export const REQUEST_PALETTE = Object.freeze([
  { id: "red", emoji: "🔴", name: "Red", hex: "#ef4444", ansi: "\x1b[31m" },
  { id: "blue", emoji: "🔵", name: "Blue", hex: "#3b82f6", ansi: "\x1b[34m" },
  { id: "green", emoji: "🟢", name: "Green", hex: "#10b981", ansi: "\x1b[32m" },
  { id: "purple", emoji: "🟣", name: "Purple", hex: "#a855f7", ansi: "\x1b[35m" },
  { id: "orange", emoji: "🟠", name: "Orange", hex: "#f97316", ansi: "\x1b[33m" },
  { id: "yellow", emoji: "🟡", name: "Yellow", hex: "#eab308", ansi: "\x1b[93m" },
  { id: "cyan", emoji: "🩵", name: "Cyan", hex: "#06b6d4", ansi: "\x1b[36m" },
  { id: "pink", emoji: "🌸", name: "Pink", hex: "#ec4899", ansi: "\x1b[95m" },
]);

export function colorForRequestId(id) {
  const num = Number(id);
  const idx = Number.isFinite(num) ? Math.abs(num) % REQUEST_PALETTE.length : 0;
  return REQUEST_PALETTE[idx];
}

/**
 * Identify client agent (hermes, omp, playground, api-client).
 * Priority:
 * 1. Verified API Key name (e.g. "hermes", "omp-laptop")
 * 2. Explicit headers (x-client, x-agent)
 * 3. SDK Fingerprints (x-stainless-lang: python -> hermes, node/js -> omp; User-Agent)
 * 4. Internal dashboard action header -> playground
 */
export function detectClient(req, keyName = null) {
  if (keyName && typeof keyName === "string" && keyName.trim().length > 0) {
    return keyName.trim();
  }
  const headers = req?.headers || {};
  if (headers["x-client"]) return String(headers["x-client"]).trim();
  if (headers["x-agent"]) return String(headers["x-agent"]).trim();

  const lang = String(headers["x-stainless-lang"] || "").toLowerCase();
  const ua = String(headers["user-agent"] || "").toLowerCase();
  const os = String(headers["x-stainless-os"] || "").toLowerCase();

  if (ua.includes("hermes")) return "hermes";
  if (ua.includes("omp")) return "omp";
  if (lang === "python") return "hermes";
  if (lang === "js" || lang === "node") return "omp";
  if (headers["x-routy-action"]) return "playground";
  if (os === "linux" && ua.includes("python")) return "hermes";
  if (os === "windows" && ua.includes("node")) return "omp";

  return "client";
}

/**
 * Global monotonically increasing request ID generator for correlation.
 */
let _seq = 0;
export function nextSeqId() {
  return ++_seq;
}
