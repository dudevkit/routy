// The guard that stands between a provider-chosen URL and this gateway (core/safeFetch.mjs).
//
// These are the tests that make the guard worth having: every case here is a way a fetch has
// been made to reach somewhere it was not meant to. DNS is mocked so a private answer can be
// produced deterministically — checking "the name looks public" is not a check at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...a) => lookupMock(...a) },
  lookup: (...a) => lookupMock(...a),
}));

const { isPrivateAddress, checkUrl, safeFetch, looksLikeImage } = await import("../core/safeFetch.mjs");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PUBLIC = "93.184.216.34";

beforeEach(() => {
  lookupMock.mockReset();
  // `all: true` returns an array of answers — the mock mirrors the API, not the shortcut.
  lookupMock.mockResolvedValue([{ address: PUBLIC }]);
});
afterEach(() => vi.restoreAllMocks());

describe("isPrivateAddress", () => {
  it("refuses every address a gateway must never reach", () => {
    for (const ip of [
      "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "127.0.0.1", "127.8.8.8",           // loopback in any of its /8
      "169.254.169.254",                   // cloud metadata, in link-local
      "169.254.0.1",
      "100.64.0.1",                        // CGNAT
      "0.0.0.0", "192.0.2.1", "198.18.0.1", // unspecified, TEST-NET, benchmarking
      "::1", "::",                          // v6 loopback / unspecified
      "fe80::1", "fc00::1", "fd12:3456::1", // link-local, unique-local
      "::ffff:10.0.0.1", "::ffff:127.0.0.1", // IPv4-mapped v4 in disguise
      "172.15.0.1",                        // just outside 172.16/12 → covered below only if in range
    ]) {
      if (ip === "172.15.0.1") continue; // asserted in the other direction below
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows globally routable addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses anything it cannot parse rather than guessing", () => {
    for (const ip of ["", "not-an-ip", null, undefined, "999.999.999.999"]) {
      expect(isPrivateAddress(ip), String(ip)).toBe(true);
    }
  });
});

describe("checkUrl", () => {
  it("refuses every scheme that is not http(s)", async () => {
    for (const url of ["ftp://example.com/a.png", "file:///etc/passwd", "data:image/png;base64,xx", "gopher://x"]) {
      const r = await checkUrl(url);
      expect(r.ok, url).toBe(false);
      expect(r.reason).toMatch(/http\(s\)|not a valid URL/);
    }
  });

  it("refuses local names before any DNS is asked", async () => {
    for (const url of ["http://localhost/x.png", "http://api.local/x", "http://router.internal/x", "http://nas.home.arpa/x"]) {
      const r = await checkUrl(url);
      expect(r.ok, url).toBe(false);
      expect(r.reason).toContain("local hostname");
    }
    expect(lookupMock).not.toHaveBeenCalled(); // refused on the name alone
  });

  it("refuses a private literal address", async () => {
    expect((await checkUrl("http://10.0.0.5/x.png")).reason).toContain("private address 10.0.0.5");
    expect((await checkUrl("http://169.254.169.254/latest/meta-data/")).reason).toContain("169.254.169.254");
    expect((await checkUrl("http://[::1]/x")).ok).toBe(false);
  });

  it("refuses a public name that resolves privately — the rebinding shape", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3" }]);
    const r = await checkUrl("http://looks-fine.example/x.png");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("private address 10.1.2.3");
  });

  it("refuses if any of several answers is private", async () => {
    lookupMock.mockResolvedValue([{ address: PUBLIC }, { address: "192.168.0.10" }]);
    expect((await checkUrl("http://multi.example/x")).ok).toBe(false);
  });

  it("refuses when the name cannot be resolved at all", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    const r = await checkUrl("http://nowhere.example/x");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ENOTFOUND");
  });

  it("accepts a private answer only when the operator named the host", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1" }]);
    expect((await checkUrl("http://stubs.test/img.png")).ok).toBe(false);
    lookupMock.mockClear();
    const r = await checkUrl("http://stubs.test/img.png", { allowHosts: ["stubs.test"] });
    expect(r.ok).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled(); // the allowance also skips the DNS round trip
  });

  it("accepts a public name and address", async () => {
    expect((await checkUrl("https://example.com/a.png")).ok).toBe(true);
    expect((await checkUrl("http://93.184.216.34/a.png")).ok).toBe(true);
  });
});

describe("safeFetch", () => {
  let server, port, hits;

  beforeEach(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === "/img.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      if (req.url === "/html.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.from("<html><body>login page</body></html>"));
      }
      if (req.url === "/big.png") {
        const big = Buffer.concat([PNG, Buffer.alloc(4096 - PNG.length)]); // 4096 bytes, honestly declared
        res.writeHead(200, { "content-type": "image/png", "content-length": String(big.length) });
        return res.end(big);
      }
      if (req.url === "/to-private") {
        res.writeHead(302, { location: "http://10.0.0.5/steal" });
        return res.end();
      }
      if (req.url === "/to-slow") {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/slow` });
        return res.end();
      }
      if (req.url === "/slow") {
        return setTimeout(() => { try { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); } catch { /* client gone */ } }, 400);
      }
      if (req.url === "/missing") {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("nope");
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => { port = server.address().port; r(); }));
  });

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise((r) => server?.close(r));
  });

  const local = (p) => `http://127.0.0.1:${port}${p}`;
  const allow = { allowHosts: ["127.0.0.1"] };

  it("fetches an image and hands back its bytes", async () => {
    const r = await safeFetch(local("/img.png"), { expectImage: true, ...allow });
    expect(r.ok).toBe(true);
    expect(r.body.equals(PNG)).toBe(true);
    expect(r.contentType).toContain("image/png");
  });

  it("refuses a body whose bytes are not an image, whatever the header says", async () => {
    const r = await safeFetch(local("/html.png"), { expectImage: true, ...allow });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not an image");
  });

  it("refuses a redirect that points at a private address", async () => {
    const r = await safeFetch(local("/to-private"), { ...allow });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("10.0.0.5");
    expect(hits).toEqual(["/to-private"]); // the private hop was never requested
  });

  it("refuses a declared size over the cap before reading the body", async () => {
    const r = await safeFetch(local("/big.png"), { maxBytes: 10, expectImage: true, ...allow });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exceeds");
    expect(hits).toEqual(["/big.png"]);
  });

  it("refuses a non-2xx answer instead of passing it on", async () => {
    const r = await safeFetch(local("/missing"), { ...allow });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.reason).toBe("HTTP 404");
  });

  it("bounds a transfer that never finishes", async () => {
    const r = await safeFetch(local("/slow"), { timeoutMs: 120, ...allow });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timed out/);
  });

  it("never fetches a private target at all", async () => {
    const r = await safeFetch("http://10.0.0.5/steal");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("private address");
    expect(hits).toEqual([]);
  });
});

describe("looksLikeImage", () => {
  it("recognises the formats it promises to serve", () => {
    const png = Buffer.from(PNG);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const gif = Buffer.from("GIF89aXXXXXXXXXX", "latin1"); // >= 12 bytes: a header, not a prefix
    const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(4)]);
    expect(looksLikeImage(png)).toBe(true);
    expect(looksLikeImage(jpeg)).toBe(true);
    expect(looksLikeImage(gif)).toBe(true);
    expect(looksLikeImage(webp)).toBe(true);
    expect(looksLikeImage(Buffer.from("<?php system($_GET[c]); ?>"))).toBe(false);
    expect(looksLikeImage(Buffer.from("<html>"))).toBe(false);
    expect(looksLikeImage(Buffer.alloc(4))).toBe(false); // too short to be anything
  });
});
