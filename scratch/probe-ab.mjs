// P4 probe 4 — controlled interleaved A/B: global dispatcher vs explicit Agent,
// alternating within one process across several rounds, so ordering and machine
// load cannot explain the difference.
import { Agent, request as undiciRequest } from "../re-e-core/node_modules/undici/index.js";

const STUB = parseInt(process.argv[2] || "20995", 10);
const N = parseInt(process.argv[3] || "15", 10);
const ROUNDS = parseInt(process.argv[4] || "4", 10);
const URL = `http://127.0.0.1:${STUB}/v1/chat/completions`;
const body = JSON.stringify({ model: "ok", stream: true, messages: [{ role: "user", content: "hi" }] });
const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function run(dispatcher) {
  const t0 = performance.now();
  const res = await undiciRequest(URL, { method: "POST", headers, body, ...(dispatcher ? { dispatcher } : {}) });
  let ttft = null;
  for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
  return ttft;
}

async function bench(label, dispatcher, n = N) {
  for (let i = 0; i < 5; i++) await run(dispatcher);
  const t = [];
  for (let i = 0; i < n; i++) t.push(await run(dispatcher));
  const p50 = pct(t, 50);
  console.log(`  ${label.padEnd(26)} p50=${String(r1(p50)).padStart(5)}ms p90=${String(r1(pct(t, 90))).padStart(5)}ms`);
  return p50;
}

// A fresh Agent per round keeps pool state from leaking across rounds.
console.log(`probe4 -> 127.0.0.1:${STUB}  n=${N} rounds=${ROUNDS}\n`);
const globalRuns = [];
const agentRuns = [];
for (let r = 1; r <= ROUNDS; r++) {
  console.log(`round ${r}`);
  const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 8, connect: { noDelay: true } });
  globalRuns.push(await bench("global (as shipped)", null));
  agentRuns.push(await bench("explicit Agent", agent));
  globalRuns.push(await bench("global again", null));
  await agent.close();
}

console.log(`\nglobal  : ${globalRuns.map(r1).join(", ")}  → median ${r1(pct(globalRuns, 50))}ms`);
console.log(`explicit: ${agentRuns.map(r1).join(", ")}  → median ${r1(pct(agentRuns, 50))}ms`);
