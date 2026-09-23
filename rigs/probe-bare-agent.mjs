// P4 probe 3 — is it "global dispatcher" or a specific default? Bare Agent vs configured.
import { Agent, Pool, request as undiciRequest, setGlobalDispatcher, getGlobalDispatcher } from "../re-e-core/node_modules/undici/index.js";

const STUB = parseInt(process.argv[2] || "20995", 10);
const N = parseInt(process.argv[3] || "20", 10);
const URL = `http://127.0.0.1:${STUB}/v1/chat/completions`;
const body = JSON.stringify({ model: "ok", stream: true, messages: [{ role: "user", content: "hi" }] });
const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function bench(label, dispatcher) {
  const run = async () => {
    const t0 = performance.now();
    const res = await undiciRequest(URL, { method: "POST", headers, body, ...(dispatcher ? { dispatcher } : {}) });
    let ttft = null;
    for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
    return ttft;
  };
  for (let i = 0; i < 5; i++) await run();
  const t = [];
  for (let i = 0; i < N; i++) t.push(await run());
  console.log(`${label.padEnd(44)} p50=${String(r1(pct(t, 50))).padStart(5)}ms`);
  return pct(t, 50);
}

const g = getGlobalDispatcher();
console.log(`global dispatcher: ${g.constructor.name}`);
console.log(`  [kOptions]:`, JSON.stringify(g[kOptionsOf()] ?? null));
function kOptionsOf() { return Object.getOwnPropertySymbols(g).find((s) => String(s).includes("Options")); }

const global0 = await bench("global dispatcher (as shipped)", null);
const bare = new Agent();
const bareMs = await bench("new Agent()  (no options)", bare);
const pool = new Pool(`http://127.0.0.1:${STUB}`, { connections: 8, keepAliveTimeout: 60_000, connect: { noDelay: true } });
const poolMs = await bench("new Pool(url, {connections:8,noDelay})", pool);

// swap the global dispatcher for a bare Agent and retest plain fetch()
setGlobalDispatcher(new Agent());
const fetchRun = async () => {
  const t0 = performance.now();
  const res = await fetch(URL, { method: "POST", headers, body });
  let ttft = null;
  for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
  return ttft;
};
for (let i = 0; i < 5; i++) await fetchRun();
const t = [];
for (let i = 0; i < N; i++) t.push(await fetchRun());
console.log(`${"global fetch after setGlobalDispatcher(Agent())".padEnd(44)} p50=${String(r1(pct(t, 50))).padStart(5)}ms`);

console.log(`\nbare Agent vs shipped global : ${r1(global0 - bareMs)}ms recovered`);
console.log(`Pool      vs shipped global : ${r1(global0 - poolMs)}ms recovered`);
await bare.close();
await pool.close();
await getGlobalDispatcher().close();
