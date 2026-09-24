// routy auth — API keys for /v1 clients, management token for /api.
// Keys are stored hashed (sha256); plaintext exists only at creation time.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// OpenAI-style keys: an `sk-` prefix so a key is recognisable at a glance, then
// 48 characters from a 62-char alphabet (mixed case + digits, no punctuation to
// survive shell/URL/header handling). Rejection sampling keeps the distribution
// flat — `byte % 62` would bias the first 8 characters.
const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_BODY_LENGTH = 48;

function randomBody(length) {
  const out = [];
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= 248) continue; // 248 = 4 × 62 — discard the biased tail
      out.push(KEY_ALPHABET[byte % 62]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

export function createApiKey(prefix = "sk") {
  const key = `${prefix}-${randomBody(KEY_BODY_LENGTH)}`;
  return { key, hash: hashKey(key) };
}

export function hashKey(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

export function verifyKey(candidate, storedHash) {
  if (typeof candidate !== "string" || typeof storedHash !== "string") return false;
  const a = Buffer.from(hashKey(candidate), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The client key from a request, in either dialect.
 *
 * OpenAI-shaped clients send `Authorization: Bearer <key>`. Anthropic-shaped ones
 * send `x-api-key: <key>` — which is what Claude Code does when it is configured
 * with ANTHROPIC_API_KEY, the more common of its two settings. Reading only Bearer
 * meant half of Claude Code's configurations got a 401 from a gateway that was
 * otherwise perfectly able to serve them.
 */
export function extractBearer(req) {
  const auth = req.headers.authorization;
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
}

// Management token: required for /api from non-loopback peers, and entered once in
// the dashboard. It used to be regenerated every boot, which was fine while /api was
// reachable only from loopback — but the gateway now listens on the network by
// default, and a token that changes on every restart would log the dashboard out
// every time the service bounced.
//
// Persisted 0600 in the state directory. Anyone who can read this file can already
// read the database sitting next to it.
export function loadOrCreateManagementToken(home) {
  const file = path.join(home, "mgmt-token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return { token: existing, created: false };
  } catch {
    // First boot, or an unreadable file — fall through and make one.
  }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch {
    // A read-only home still gets a working token for this boot; it just will not
    // survive a restart, which is better than refusing to start.
  }
  return { token, created: true };
}

export function createBootstrapToken() {
  return crypto.randomBytes(24).toString("hex");
}
