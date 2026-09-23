// Diagnose a model probe against a real provider: what does the upstream actually
// send, and where does the time go? Never prints the API key.
// Usage: node rigs/probe-diagnose.mjs [homeDir] [modelSubstring]
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";

const HOME = process.argv[2] || path.join(os.homedir(), ".re-e");
const NEEDLE = process.argv[3] || "";

const db = new DatabaseSync(path.join(HOME, "data", "re-e.db"));
const node = db.prepare(`SELECT * FROM provider_nodes ORDER BY created_at LIMIT 1`).get();
const conn = db.prepare(`SELECT * FROM connections WHERE node_id = ? AND status = 'active' ORDER BY priority LIMIT 1`).get(node.id);
const rows = db.prepare(`SELECT model, enabled, stale FROM node_models WHERE node_id = ? ORDER BY model`).all(node.id);
const key = JSON.parse(conn.credentials).apiKey;

const model = (NEEDLE && rows.find((r) => r.model.includes(NEEDLE))?.model) || rows[0]?.model;
console.log(`provider : ${node.name} (${node.prefix})  ${node.base_url}`);
console.log(`key      : ${conn.name}  (${key.slice(0, 6)}…, ${key.length} chars)`);
console.log(`model    : ${model}   of ${rows.length} listed\n`);

const url = `${node.base_url.replace(/\/+$/, "")}/chat/completions`;
const body = JSON.stringify({ model, stream: true, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
console.log(`POST ${url}`);
console.log(`body: ${body}\n`);

const t0 = Date.now();
const LOG = path.join(process.cwd(), "rigs", "probe-diagnose.log");
import fs from "node:fs";
fs.writeFileSync(LOG, "");
const stage = (s) => {
  const line = `[${String(Date.now() - t0).padStart(6)}ms] ${s}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n"); // survives a kill — stdout to a pipe is buffered
};

let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
  });
} catch (err) {
  stage(`FETCH FAILED: ${err?.cause?.message ?? err.message}`);
  process.exit(1);
}
stage(`headers: HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`);

if (!res.ok) {
  const text = await res.text();
  stage(`error body: ${text.slice(0, 500)}`);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
let frames = 0;
const deadline = Date.now() + 60_000;

while (Date.now() < deadline) {
  const { done, value } = await reader.read();
  if (done) { stage("stream ended"); break; }
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const frame = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 2);
    if (!frame) continue;
    frames++;
    let keys = ""; try { const o = JSON.parse(frame.startsWith("data:") ? frame.slice(5).trim() : frame); const d = o.choices?.[0]?.delta ?? o.choices?.[0]?.message ?? {}; keys = "deltaKeys=" + JSON.stringify(Object.keys(d)) + " finish=" + o.choices?.[0]?.finish_reason; } catch {} 
    const oneLine = frame.replace(/\s+/g, " ").slice(0, 150) + "   || " + keys;
    stage(`frame ${frames}: ${oneLine}`);
    if (frames >= 40) { stage("… stopping after 40 frames"); await reader.cancel(); break; }
  }
}
if (Date.now() >= deadline) stage("STILL OPEN after 60s — no completion, no close");
console.log(`\ntotal ${frames} frames in ${Date.now() - t0}ms`);
db.close();
