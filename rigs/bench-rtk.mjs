// P0.4b — RTK-on vs RTK-off bench with a compressible tool_result (git-diff shape).
// Toggles settings.rtkEnabled in the isolated db (upstream reads settings per request).
// Usage: node rigs/bench-rtk.mjs [N]
import http from "http";
import { DatabaseSync } from "node:sqlite";
import path from "path";

const N = parseInt(process.argv[2] || "30", 10);
const DATA_DIR = path.resolve("rigs/bench-data");
const db = new DatabaseSync(path.join(DATA_DIR, "db", "data.sqlite"));
db.exec("PRAGMA busy_timeout = 5000");

function setRtk(enabled) {
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
  const s = JSON.parse(row.data);
  s.rtkEnabled = enabled;
  db.prepare("UPDATE settings SET data = ? WHERE id = 1").run(JSON.stringify(s));
}

// ~8KB git-diff-shaped tool_result (RTK gitDiff filter target)
const lines = ["diff --git a/src/app.js b/src/app.js", "index 1111111..2222222 100644", "--- a/src/app.js", "+++ b/src/app.js"];
for (let h = 0; h < 8; h++) {
  lines.push(`@@ -${h * 120 + 1},120 +${h * 120 + 1},124 @@ function block${h}()`);
  for (let i = 0; i < 120; i++) lines.push(`   context line ${h}-${i} const value = compute(${i});`);
  for (let i = 0; i < 4; i++) lines.push(`+  added line ${h}-${i} const fresh = compute(${i});`);
}
const DIFF = lines.join("\n");
console.log("tool_result bytes:", DIFF.length);

const body = JSON.stringify({
  model: "bench/test-model", stream: true, max_tokens: 100,
  messages: [
    { role: "user", content: "Check the diff and summarize" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "git_diff", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: DIFF },
  ],
});

function once() {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(
      { host: "127.0.0.1", port: 20991, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let ttft = null, bytes = 0;
        res.on("data", (c) => { if (ttft === null) ttft = performance.now() - t0; bytes += c.length; });
        res.on("end", () => resolve({ ttft, total: performance.now() - t0, status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
async function bench(n, warm = 3) {
  for (let i = 0; i < warm; i++) await once();
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await once());
  const t = runs.map((r) => r.ttft), tot = runs.map((r) => r.total);
  return { ok: runs.filter((r) => r.status === 200).length, ttft_p50: pct(t, 50), ttft_p90: pct(t, 90), total_p50: pct(tot, 50) };
}

const out = {};
for (const flag of [false, true]) {
  setRtk(flag);
  await new Promise((r) => setTimeout(r, 300));
  out[flag ? "rtk_on" : "rtk_off"] = await bench(N);
  console.log(flag ? "rtk_on " : "rtk_off", JSON.stringify(out[flag ? "rtk_on" : "rtk_off"]));
}
console.log(JSON.stringify({ at: new Date().toISOString(), n: N, ...out }, null, 2));
db.close();
