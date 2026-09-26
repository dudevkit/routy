// Why does a request through an http:// proxy fail? Reproduce minimally, print the cause.
import http from "node:http";
import { getProxyAgent } from "./core/proxy.mjs";
import { fetch as undiciFetch } from "undici";

const upstream = http.createServer((req, res) => {
  console.log("  upstream saw:", req.method, req.url);
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

const proxy = http.createServer((req, res) => {
  console.log("  proxy saw:", req.method, JSON.stringify(req.url), "hdr:", Object.keys(req.headers).join(","));
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let pathname = req.url;
    try { const u = new URL(req.url); pathname = u.pathname + u.search; } catch { /* path form */ }
    const up = http.request(
      { host: "127.0.0.1", port: upstreamPort, path: pathname, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` } },
      (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); },
    );
    up.on("error", (e) => { console.log("  proxy→upstream error:", e.message); res.writeHead(502).end(); });
    up.end(Buffer.concat(chunks));
  });
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;

const agent = getProxyAgent(`http://127.0.0.1:${proxyPort}`);
console.log("agent:", agent ? agent.constructor.name : null);
try {
  const res = await undiciFetch("http://127.0.0.1:9/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: 1 }),
    dispatcher: agent,
  });
  console.log("RESULT:", res.status, await res.text());
} catch (err) {
  console.log("FAILED:", err.message, "| cause:", err.cause?.code, err.cause?.message);
}
proxy.closeAllConnections?.();
proxy.close();
upstream.close();
