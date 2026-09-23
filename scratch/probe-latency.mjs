// P4 probe — is the ~16ms proxy overhead undici's, or RE-E's own code?
// Compares warm sequential dispatch to the same stub through four paths:
//   core http.request (keep-alive off) | core http.request (keep-alive on)
//   global fetch (undici)              | fetch with a noDelay-pinned Agent
import http from "node:http";
const { Agent, request: undiciRequest } = await import("../re-e-core/node_modules/undici/index.js");

const STUB = parseInt(process.argv[2] || "20995", 10);
const N = parseInt(process.argv[3] || "30", 10);
const URL = `http://127.0.0.1:${STUB}/v1/chat/completions`;
const body = JSON.stringify({ model: "ok", stream: true, messages: [{ role: "user", content: "count to five" }] });
const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function bench(label, fn, n = N, warmup = 5) {
  for (let i = 0; i < warmup; i++) await fn();
  const ttfts = [];
  for (let i = 0; i < n; i++) ttfts.push((await fn()).ttft);
  console.log(`${label.padEnd(34)} ttft p50=${r1(pct(ttfts, 50))}ms p90=${r1(pct(ttfts, 90))}ms`);
  return pct(ttfts, 50);
}

// ── core http.request, no keep-alive (fresh socket each time) ──
function coreNoKeepAlive() {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({ host: "127.0.0.1", port: STUB, path: "/v1/chat/completions", method: "POST", headers, agent: false }, (res) => {
      let ttft = null;
      res.on("data", () => { if (ttft === null) ttft = performance.now() - t0; });
      res.on("end", () => resolve({ ttft }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ── core http.request, shared keep-alive agent ──
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
function coreKeepAlive() {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({ host: "127.0.0.1", port: STUB, path: "/v1/chat/completions", method: "POST", headers, agent: keepAliveAgent }, (res) => {
      let ttft = null;
      res.on("data", () => { if (ttft === null) ttft = performance.now() - t0; });
      res.on("end", () => resolve({ ttft }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ── global fetch (undici defaults) ──
async function globalFetch() {
  const t0 = performance.now();
  const res = await fetch(URL, { method: "POST", headers, body });
  let ttft = null;
  for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
  return { ttft };
}

// ── undici request with an explicit Agent (noDelay on, keep-alive on) ──
const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 8, connect: { noDelay: true } });
async function undiciAgent() {
  const t0 = performance.now();
  const res = await undiciRequest(URL, { method: "POST", headers, body, dispatcher: agent });
  let ttft = null;
  for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
  return { ttft };
}

console.log(`probe -> 127.0.0.1:${STUB}  n=${N} warm sequential\n`);
const a = await bench("core http (new socket each)", coreNoKeepAlive);
const b = await bench("core http (keep-alive agent)", coreKeepAlive);
const c = await bench("global fetch (undici default)", globalFetch);
const d = await bench("undici request + tuned Agent", undiciAgent);

console.log(`\nundici-default penalty vs core keep-alive : ${r1(c - b)}ms`);
console.log(`tuned-Agent penalty vs core keep-alive     : ${r1(d - b)}ms`);
await agent.close();
keepAliveAgent.destroy();
