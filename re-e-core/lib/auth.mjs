// RE-E auth — API keys for /v1 clients, bootstrap token for /api management.
// Keys are stored hashed (sha256); plaintext exists only at creation time.
import crypto from "node:crypto";

export function createApiKey(prefix = "re") {
  const key = `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
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

export function extractBearer(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Management bootstrap token: printed at boot when no session exists yet.
// (Real session store lands with P2; until then /api accepts the bootstrap token.)
export function createBootstrapToken() {
  return crypto.randomBytes(24).toString("hex");
}
