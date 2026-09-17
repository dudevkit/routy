// P0.4 baseline bench — TTFT/throughput: direct-to-stub vs routed-through-9Router.
// Usage: node scratch/bench.mjs [N]
import http from "http";

const N = parseInt(process.argv[2] || "40", 10);
const STUB = { host: "127.0.0.1", port: 20990, path: "/v1/chat/completions" };
const ROUTER = { host: "127.0.0.1", port: 20991, path: "/v1/chat/completions" };

const body = JSON.stringify({
  model: "bench/test-model",
  stream: true,
  max_tokens: 100,
  messages: [{ role: "user", content: "Say hello and count to five." }],
});

function once(target) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(
      { ...target, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: "Bearer bench-key" } },
      (res) => {
        let ttft = null, bytes = 0;
        res.on("data", (c) => { if (ttft === null) ttft = performance.now() - t0; bytes += c.length; });
        res.on("end", () => resolve({ ttft, total: performance.now() - t0, bytes, status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }

async function bench(label, target, n, warmup = 5) {
  for (let i = 0; i < warmup; i++) await once(target);
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await once(target));
  const ttfts = runs.map((r) => r.ttft);
  const totals = runs.map((r) => r.total);
  const ok = runs.filter((r) => r.status === 200).length;
  return {
    label, ok, n,
    ttft_p50: Math.round(pct(ttfts, 50)), ttft_p90: Math.round(pct(ttfts, 90)), ttft_p99: Math.round(pct(ttfts, 99)),
    total_p50: Math.round(pct(totals, 50)), total_p90: Math.round(pct(totals, 90)),
  };
}

const direct = await bench("direct->stub", STUB, N);
const routed = await bench("router->stub", ROUTER, N);
const overhead = {
  ttft_p50_delta: routed.ttft_p50 - direct.ttft_p50,
  ttft_p90_delta: routed.ttft_p90 - direct.ttft_p90,
};
const results = { at: new Date().toISOString(), n: N, direct, routed, overhead };
console.log(JSON.stringify(results, null, 2));
