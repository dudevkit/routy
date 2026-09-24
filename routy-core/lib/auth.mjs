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

// ── dashboard login ──────────────────────────────────────────────────────────
//
// A password, not a generated token. The token worked but was the wrong shape: a
// 48-character string you had to find in the service log and paste into every new
// browser. A password is something you know, and a session cookie means you enter it
// once. Same security property — the server refuses unauthenticated requests — with
// none of the friction.
//
// scrypt rather than bcrypt: it is in node:crypto, and routy has no runtime
// dependencies to spend on this.

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };

/** `scrypt$N$r$p$salt$hash`, all base64 — the parameters travel with the hash. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * The key that signs session cookies. Generated once, kept 0600 in the state
 * directory, stable across restarts — so a logged-in browser stays logged in when the
 * service bounces. Regenerating it invalidates every session, which is also the
 * emergency "log everyone out" switch.
 */
export function loadOrCreateSessionKey(home) {
  const file = path.join(home, "session-key");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // first boot, or unreadable — make one
  }
  const key = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  } catch {
    // a read-only home still gets a working key for this boot
  }
  return key;
}

const SESSION_COOKIE = "routy_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** `issuedAt.hmac` — stateless, so there is no session table to grow or expire. */
export function createSessionToken(key, now = Date.now()) {
  const issuedAt = String(now);
  const mac = crypto.createHmac("sha256", key).update(issuedAt).digest("base64url");
  return `${issuedAt}.${mac}`;
}

export function verifySessionToken(token, key, now = Date.now()) {
  if (typeof token !== "string" || typeof key !== "string" || !key) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const issuedAt = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(issuedAt)) return false;
  const expected = crypto.createHmac("sha256", key).update(issuedAt).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return now - Number(issuedAt) < SESSION_TTL_MS;
}

/** The session cookie from a request, or null. */
export function readSessionCookie(req) {
  const raw = req.headers?.cookie;
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookieHeader(token, { secure = false } = {}) {
  // HttpOnly: the dashboard never needs to read it, and that keeps it away from any
  // script that manages to run on the page.
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export const clearSessionCookieHeader = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export const DEFAULT_PASSWORD = "123456";
