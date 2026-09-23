// P4 probe 2 — which undici Agent knob recovers the ~16ms?
import http from "node:http";
const { Agent, request: undiciRequest, setGlobalDispatcher, getGlobalDispatcher } = await import("../re-e-core/node_modules/undici/index.js");

const STUB = parseInt(process.argv[2] || "20995", 10);
const N = parseInt(process.argv[3] || "25", 10);
const URL = `http://127.0.0.1:${STUB}/v1/chat/completions`;
const body = JSON.stringify({ model: "ok", stream: true, messages: [{ role: "user", content: "count to five" }] });
const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function bench(label, makeDispatcher, n = N, warmup = 5) {
  const dispatcher = makeDispatcher ? makeDispatcher() : null;
  const run = async () => {
    const t0 = performance.now();
    const res = await undiciRequest(URL, { method: "POST", headers, body, ...(dispatcher ? { dispatcher } : {}) });
    let ttft = null;
    for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
    return ttft;
  };
  for (let i = 0; i < warmup; i++) await run();
  const ttfts = [];
  for (let i = 0; i < n; i++) ttfts.push(await run());
  console.log(`${label.padEnd(46)} p50=${String(r1(pct(ttfts, 50))).padStart(5)}ms  p90=${String(r1(pct(ttfts, 90))).padStart(5)}ms`);
  if (dispatcher) await dispatcher.close();
  return pct(ttfts, 50);
}

console.log(`probe2 -> 127.0.0.1:${STUB}  n=${N}\n`);

const base = await bench("default global dispatcher", null);
const noDelay = await bench("Agent { connect.noDelay: true }", () => new Agent({ connect: { noDelay: true } }));
const keepAlive = await bench("Agent { keepAliveTimeout: 60s }", () => new Agent({ keepAliveTimeout: 60_000 }));
const conns = await bench("Agent { connections: 8 }", () => new Agent({ connections: 8 }));
const pipelining = await bench("Agent { pipelining: 10 }", () => new Agent({ pipelining: 10 }));
const full = await bench("Agent { all of the above }", () => new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 8, pipelining: 10, connect: { noDelay: true } }));

// does replacing the GLOBAL dispatcher fix plain fetch()?
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 8, connect: { noDelay: true } }));
const viaFetch = await (async () => {
  const run = async () => {
    const t0 = performance.now();
    const res = await fetch(URL, { method: "POST", headers, body });
    let ttft = null;
    for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
    return ttft;
  };
  for (let i = 0; i < 5; i++) await run();
  const ttfts = [];
  for (let i = 0; i < N; i++) ttfts.push(await run());
  console.log(`${"global fetch AFTER setGlobalDispatcher".padEnd(46)} p50=${String(r1(pct(ttfts, 50))).padStart(5)}ms  p90=${String(r1(pct(ttfts, 90))).padStart(5)}ms`);
  return pct(ttfts, 50);
})();

console.log(`\nrecovered by noDelay alone      : ${r1(base - noDelay)}ms`);
console.log(`recovered by keepAliveTimeout   : ${r1(base - keepAlive)}ms`);
console.log(`recovered by connections        : ${r1(base - conns)}ms`);
console.log(`recovered by full tuned agent   : ${r1(base - full)}ms`);
console.log(`recovered by global replacement : ${r1(base - viaFetch)}ms`);
await getGlobalDispatcher().close();
