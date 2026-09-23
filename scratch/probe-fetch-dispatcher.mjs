// P4 probe 5 — does an explicit tuned dispatcher make plain fetch() reliably fast?
// Interleaved rounds (A/B/A) so machine load and ordering can't explain the result.
import { Agent } from "../re-e-core/node_modules/undici/index.js";

const STUB = parseInt(process.argv[2] || "20995", 10);
const N = parseInt(process.argv[3] || "15", 10);
const ROUNDS = parseInt(process.argv[4] || "3", 10);
const URL = `http://127.0.0.1:${STUB}/v1/chat/completions`;
const body = JSON.stringify({ model: "ok", stream: true, messages: [{ role: "user", content: "hi" }] });
const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function run(opts) {
  const t0 = performance.now();
  const res = await fetch(URL, { method: "POST", headers, body, ...opts });
  let ttft = null;
  for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
  return ttft;
}

async function bench(label, opts, n = N) {
  for (let i = 0; i < 5; i++) await run(opts);
  const t = [];
  for (let i = 0; i < n; i++) t.push(await run(opts));
  const p50 = pct(t, 50);
  console.log(`  ${label.padEnd(30)} p50=${String(r1(p50)).padStart(5)}ms p90=${String(r1(pct(t, 90))).padStart(5)}ms min=${r1(Math.min(...t))}`);
  return p50;
}

console.log(`probe5 -> 127.0.0.1:${STUB}  n=${N} rounds=${ROUNDS}\n`);
const tuned = [];
const plain = [];
for (let r = 1; r <= ROUNDS; r++) {
  console.log(`round ${r}`);
  const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16, pipelining: 1, connect: { noDelay: true } });
  plain.push(await bench("fetch (default dispatcher)", {}));
  tuned.push(await bench("fetch + tuned dispatcher", { dispatcher: agent }));
  await agent.close();
}

console.log(`\ndefault dispatcher : ${plain.map(r1).join(", ")}  → median ${r1(pct(plain, 50))}ms`);
console.log(`tuned dispatcher   : ${tuned.map(r1).join(", ")}  → median ${r1(pct(tuned, 50))}ms`);
