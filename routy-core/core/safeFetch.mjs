// A fetch that refuses to become an SSRF.
//
// Used when routy dereferences a URL it did not compose: an image URL returned by a provider
// (`?response_format=binary` with a provider that answers `url`), and later web fetch. The
// node's own base URL is NOT fetched through this — that address is user-configured, may be on
// a LAN on purpose (local ComfyUI, a house OpenAI-compatible server), and is trusted the way
// any node is.
//
// Policy, in the order it refuses (each of these is a real bypass, and the reference tree has
// a test for the first four — see 9router/tests/unit/image-fetch-hardening.test.js):
//   1. scheme must be http or https (no file:, no data:, no ftp:)
//   2. the hostname must not be a private name: localhost, *.local, *.internal, *.home.arpa
//   3. a literal IP must be globally routable — loopback, RFC1918, link-local, CGNAT, v6
//      unique-local and the IPv4-mapped forms are all refused
//   4. the HOST IT RESOLVES TO must be globally routable: DNS is attacker-chosen, so checking
//      the name alone (or nothing at all) lets a public hostname point at 169.254.169.254
//   5. redirects are re-validated hop by hop: one redirect to an internal host defeats 1-4
//   6. the body must be a plausible size and — when a content type is expected — a plausible
//      type. An image that is actually a 200 MB PHP file is the same attack wearing a costume.
//
// The residual a user-space fetch cannot close: a name resolving publicly at check time and
// internally at connect time (DNS rebinding). Closing it needs connecting to the checked
// address directly, which trades away SNI/TLS for provider CDNs. Documented, not hidden.
import dns from "node:dns/promises";
import net from "node:net";

/** Hostnames that never need DNS: they are local by definition. */
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i;

/**
 * True for addresses that are not globally routable — the whole of RFC1918 plus the
 * neighbours that are equally dangerous when reached from a gateway: loopback (the gateway's
 * own host, where its admin API lives), link-local and the cloud metadata address that sits
 * in it, CGNAT (where many provider NATs live, so a fetch there is somebody's internal),
 * unspecified, and v6 loopback/unique-local/link-local. IPv4-mapped v6 (::ffff:10.0.0.1) is
 * checked as the v4 it is.
 */
export function isPrivateAddress(ip) {
  if (typeof ip !== "string" || ip.length === 0) return true;
  const mapped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const version = net.isIP(mapped);
  if (version === 4) {
    const parts = mapped.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                                   // 0.0.0.0/8 "this network"
    if (a === 10) return true;                                  // 10/8
    if (a === 127) return true;                                 // 127/8 loopback
    if (a === 169 && b === 254) return true;                    // 169.254/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
    if (a === 192 && b === 168) return true;                    // 192.168/16
    if (a === 192 && b === 0) return true;                      // 192.0.0/24 IETF, 192.0.2/24 TEST-NET
    if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18/15 benchmarking
    if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGNAT
    return false;
  }
  if (version === 6) {
    const norm = mapped.toLowerCase();
    if (norm === "::" || norm === "::1") return true;           // unspecified / loopback
    if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // unique-local fc00::/7
    if (norm.startsWith("fe8") || norm.startsWith("fe9") || norm.startsWith("fea") || norm.startsWith("feb")) return true; // fe80::/10
    return false;
  }
  return true; // not a parseable IP at all → refuse rather than guess
}

/** Parse-check a URL and reject everything that is not a plain http(s) target. */
function parseHttpUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { error: "url must be a non-empty string" };
  let url;
  try { url = new URL(raw); } catch { return { error: "not a valid URL" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `refusing ${url.protocol} URL — only http(s) may be fetched` };
  }
  if (LOCAL_NAMES.test(url.hostname)) return { error: `refusing local hostname "${url.hostname}"` };
  return { url };
}

/**
 * Check one URL without fetching it. Returns `{ ok }` or `{ ok:false, reason }`, so callers
 * can refuse before any bytes move — and tests can assert the refusal, not just the absence
 * of a request.
 *
 * `allowHosts`: hostnames permitted to resolve privately. The image path passes the node's
 * own base URL host here, because a local provider naming itself is not an attack.
 */
export async function checkUrl(raw, { allowHosts = [] } = {}) {
  const parsed = parseHttpUrl(raw);
  if (parsed.error) return { ok: false, reason: parsed.error };
  const url = parsed.url;
  const host = url.hostname.toLowerCase();
  const allowed = allowHosts.some((h) => String(h || "").toLowerCase() === host);
  if (allowed) return { ok: true, url };

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, reason: `refusing private address ${host}` };
    return { ok: true, url };
  }

  // URL keeps IPv6 literals bracketed ([::1]), and net.isIP only accepts the bare form —
  // without this an IPv6 literal skips the literal check and gets asked of DNS instead,
  // where the answer (or the failure) decides something the address already said.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) return { ok: false, reason: `refusing private address ${bare}` };
    return { ok: true, url };
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: false });
  } catch (err) {
    return { ok: false, reason: `cannot resolve ${host}: ${String(err?.code || err?.message || err)}` };
  }
  // ANY private answer refuses the URL. A public host with one internal A record is the
  // rebinding shape, and taking turns between addresses is exactly what it is for.
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) return { ok: false, reason: `${host} resolves to private address ${bad.address}` };
  return { ok: true, url };
}

/** PNG / JPEG / WebP / GIF magic bytes. A body that claims `image/png` and is not one is
 *  refused by its bytes, because the header is the thing being lied about. */
export function looksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // \x89PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;                     // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;                     // GIF
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return true; // WebP
  return false;
}

/**
 * Fetch a URL after the checks above, honouring the same limits on every hop.
 *
 * @returns {Promise<{ok:true, status:number, contentType:string|null, body:Buffer, url:string} |
 *                   {ok:false, reason:string, status?:number}>}
 * @param {object} opts
 * @param {number} [opts.maxBytes]    hard cap on the body (images are MiB, not GiB)
 * @param {number} [opts.timeoutMs]   whole-transfer budget, redirects included
 * @param {number} [opts.redirects]   hops remaining; each is re-validated from scratch
 * @param {string[]} [opts.allowHosts] hostnames allowed to resolve privately
 * @param {string} [opts.expectImage] require image magic bytes in the body
 */
export async function safeFetch(raw, {
  maxBytes = 32 * 1024 * 1024,
  timeoutMs = 15_000,
  redirects = 3,
  allowHosts = [],
  expectImage = false,
} = {}) {
  const check = await checkUrl(raw, { allowHosts });
  if (!check.ok) return { ok: false, reason: check.reason };

  let res;
  try {
    res = await fetch(check.url, {
      redirect: "manual",               // never hand a hop to fetch's redirect handling
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: expectImage ? "image/*" : "*/*" },
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" || err?.name === "AbortError"
      ? `timed out after ${timeoutMs}ms`
      : `could not fetch: ${String(err?.cause?.code || err?.message || err)}`;
    return { ok: false, reason };
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    try { await res.arrayBuffer(); } catch { /* drain */ }
    if (!location) return { ok: false, reason: `redirect with no location (HTTP ${res.status})` };
    if (redirects <= 0) return { ok: false, reason: "too many redirects" };
    // Re-validated: a redirect is the cheapest way to turn a safe URL into an unsafe one.
    return safeFetch(new URL(location, check.url).toString(), { maxBytes, timeoutMs, redirects: redirects - 1, allowHosts, expectImage });
  }
  if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.arrayBuffer(); } catch { /* drain */ }
    return { ok: false, reason: `declared size ${declared} exceeds the ${maxBytes} byte cap` };
  }

  let body;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: `reading body failed: ${String(err?.message || err)}` };
  }
  if (body.length > maxBytes) return { ok: false, reason: `body of ${body.length} bytes exceeds the ${maxBytes} byte cap` };

  const contentType = res.headers.get("content-type");
  if (expectImage && !looksLikeImage(body)) {
    return { ok: false, reason: `payload is not an image (declared ${contentType || "unknown type"})` };
  }

  return { ok: true, status: res.status, contentType, body, url: check.url };
}
