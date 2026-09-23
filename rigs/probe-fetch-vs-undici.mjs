// P4 probe 6 — built-in fetch vs npm undici + tuned pool, interleaved rounds.
// These are DIFFERENT undici copies: Node bundles its own, re-e-core depends on npm v8.
import { Agent, request as undiciRequest } from "../re-e-core/node_modules/undici/index.js";

const STUB = parseInt(process.argv[2] || "20995", 10);
const N = parseInt(process.argv[3] || "20", 10);
const ROUNDS = parseInt(process.argv[4] || "4", 10);
const URL = `http://127.0.0.1:${STUB}/v1/chat/completions`;
const body = JSON.stringify({ model: "ok", stream: true, messages: [{ role: "user", content: "hi" }] });
const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function viaFetch() {
  const t0 = performance.now();
  const res = await fetch(URL, { method: "POST", headers, body });
  let ttft = null;
  for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
  return ttft;
}

function viaUndici(dispatcher) {
  return (async () => {
    const t0 = performance.now();
    const res = await undiciRequest(URL, { method: "POST", headers, body, dispatcher });
    let ttft = null;
    for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
    return ttft;
  })();
}

async function bench(label, fn, n = N) {
  for (let i = 0; i < 5; i++) await fn();
  const t = [];
  for (let i = 0; i < n; i++) t.push(await fn());
  const p50 = pct(t, 50);
  console.log(`  ${label.padEnd(34)} p50=${String(r1(p50)).padStart(5)}ms p90=${String(r1(pct(t, 90))).padStart(5)}ms min=${r1(Math.min(...t))}`);
  return p50;
}

console.log(`probe6 -> 127.0.0.1:${STUB}  n=${N} rounds=${ROUNDS}\n`);
const fetchRuns = [];
const undiciRuns = [];
for (let r = 1; r <= ROUNDS; r++) {
  console.log(`round ${r}`);
  const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16, pipelining: 1, connect: { noDelay: true } });
  fetchRuns.push(await bench("built-in fetch", viaFetch));
  undiciRuns.push(await bench("npm undici + tuned Agent", () => viaUndici(agent)));
  await agent.close();
}

console.log(`\nbuilt-in fetch      : ${fetchRuns.map(r1).join(", ")}  → median ${r1(pct(fetchRuns, 50))}ms`);
console.log(`npm undici + pool   : ${undiciRuns.map(r1).join(", ")}  → median ${r1(pct(undiciRuns, 50))}ms`);
