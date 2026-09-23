// P4 bench — proxy-added latency of RE-E vs hitting the upstream directly.
// Both targets drive the same chaos stub (mode "ok"), so the delta is RE-E's cost.
// Usage: node rigs/bench-ree.mjs [N] [gatewayPort] [stubPort]
import http from "node:http";

const N = parseInt(process.argv[2] || "60", 10);
const GW = parseInt(process.argv[3] || process.env.GW_PORT || "8015", 10);
const STUB = parseInt(process.argv[4] || process.env.STUB_PORT || "20995", 10);

function call(port, model, key, extraHeaders = {}) {
  const body = JSON.stringify({ model, stream: true, max_tokens: 100, messages: [{ role: "user", content: "count to five" }] });
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(
      {
        host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(key ? { authorization: `Bearer ${key}` } : {}), ...extraHeaders },
      },
      (res) => {
        let ttft = null;
        let bytes = 0;
        res.on("data", (c) => { if (ttft === null) ttft = performance.now() - t0; bytes += c.length; });
        res.on("end", () => resolve({ ttft, total: performance.now() - t0, bytes, status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function bench(label, fn, n, warmup = 10) {
  for (let i = 0; i < warmup; i++) await fn();
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await fn());
  const ttft = runs.map((r) => r.ttft);
  const total = runs.map((r) => r.total);
  const bad = runs.filter((r) => r.status !== 200).length;
  return {
    label, n, bad,
    ttft: { p50: r1(pct(ttft, 50)), p90: r1(pct(ttft, 90)), p99: r1(pct(ttft, 99)) },
    total: { p50: r1(pct(total, 50)), p90: r1(pct(total, 90)), p99: r1(pct(total, 99)) },
  };
}

// mint a key for the routed leg
const key = await new Promise((resolve, reject) => {
  const body = JSON.stringify({ name: "bench" });
  const req = http.request({ host: "127.0.0.1", port: GW, path: "/api/keys", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => { try { resolve(JSON.parse(d).key); } catch { reject(new Error(`key mint failed: ${res.statusCode} ${d}`)); } });
  });
  req.on("error", reject);
  req.end(body);
});

const direct = await bench("direct -> stub", () => call(STUB, "ok", null), N);
const routed = await bench("RE-E -> stub", () => call(GW, "chaos/ok", key), N);

const delta = {
  ttft_p50: r1(routed.ttft.p50 - direct.ttft.p50),
  ttft_p90: r1(routed.ttft.p90 - direct.ttft.p90),
  ttft_p99: r1(routed.ttft.p99 - direct.ttft.p99),
  total_p50: r1(routed.total.p50 - direct.total.p50),
};

console.log(JSON.stringify({ at: new Date().toISOString(), n: N, direct, routed, overheadMs: delta }, null, 2));
