// P4 probe 7 — does having node:sqlite open (WAL) slow down built-in fetch in the
// same process? RE-E's process has the DB open; the bare probes did not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../re-e-core/db/driver.mjs";

const STUB = parseInt(process.argv[2] || "20995", 10);
const N = parseInt(process.argv[3] || "15", 10);
const URL = `http://127.0.0.1:${STUB}/v1/chat/completions`;
const body = JSON.stringify({ model: "ok", stream: true, messages: [{ role: "user", content: "hi" }] });
const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function bench(label, n = N, after = null) {
  const run = async () => {
    const t0 = performance.now();
    const res = await fetch(URL, { method: "POST", headers, body });
    let ttft = null;
    for await (const _ of res.body) { if (ttft === null) ttft = performance.now() - t0; }
    if (after) after();
    return ttft;
  };
  for (let i = 0; i < 5; i++) await run();
  const t = [];
  for (let i = 0; i < n; i++) t.push(await run());
  console.log(`${label.padEnd(46)} p50=${String(r1(pct(t, 50))).padStart(5)}ms min=${r1(Math.min(...t))} max=${r1(Math.max(...t))}`);
  return pct(t, 50);
}

console.log(`probe7 -> 127.0.0.1:${STUB}\n`);
await bench("1. no db open");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ree-probe-"));
const db = openDatabase(tmp);
await bench("2. db open (WAL, idle)");

const ins = db.prepare(`INSERT INTO usage_events (ts, node_id, connection_id, api_key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, cost_usd, ttft_ms, duration_ms, error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
await bench("3. db open + 1 insert per request", N, () => ins.run(Date.now(), null, null, null, "m", "ok", 1, 1, null, null, 1, 1, null));

// does a transaction-wrapped insert change it?
await bench("4. db open + BEGIN/INSERT/COMMIT per request", N, () => { db.exec("BEGIN"); ins.run(Date.now(), null, null, null, "m", "ok", 1, 1, null, null, 1, 1, null); db.exec("COMMIT"); });

// timing of the write itself
const t0 = performance.now();
for (let i = 0; i < 50; i++) ins.run(Date.now(), null, null, null, "m", "ok", 1, 1, null, null, 1, 1, null);
console.log(`\n50 bare inserts: ${r1(performance.now() - t0)}ms total`);
const t1 = performance.now();
for (let i = 0; i < 50; i++) { db.exec("BEGIN"); ins.run(Date.now(), null, null, null, "m", "ok", 1, 1, null, null, 1, 1, null); db.exec("COMMIT"); }
console.log(`50 txn-wrapped inserts: ${r1(performance.now() - t1)}ms total`);
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
