// P4 live check — latency-aware routing: a combo declared slow-first must end up
// preferring the fast upstream once the EWMA has measured both.
// Usage: node rigs/p4-fastest.mjs [gatewayPort] [fastStubPort] [slowStubPort]
import http from "node:http";

const GW = Number(process.argv[2] || 8015);
const FAST = Number(process.argv[3] || 20995);
const SLOW = Number(process.argv[4] || 20996);
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

let KEY = null;
function req(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { "content-type": "application/json" };
    if (payload) headers["content-length"] = Buffer.byteLength(payload);
    if (KEY && (p.startsWith("/v1") || p.startsWith("/api"))) headers.authorization = `Bearer ${KEY}`;
    const r = http.request({ host: "127.0.0.1", port: GW, path: p, method, headers, timeout: 60_000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, body: "ERR timeout" }); });
    r.end(payload ?? undefined);
  });
}

const ask = (model) => req("POST", "/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: "x" }] });

async function nodeByPrefix(prefix) {
  const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
  return nodes.find((n) => n.prefix === prefix) ?? null;
}

async function ensureNode(prefix, stubPort) {
  const existing = await nodeByPrefix(prefix);
  if (existing) return existing.id;
  const r = await req("POST", "/api/nodes", { name: prefix, prefix, baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "k" });
  if (r.status !== 201) throw new Error(`node ${prefix}: ${r.status} ${r.body}`);
  const id = JSON.parse(r.body).id;
  await req("POST", `/api/nodes/${id}/connections`, { name: "k", apiKey: "k" });
  return id;
}

const lastNode = async () => {
  const rows = JSON.parse((await req("GET", "/api/usage/history?limit=1")).body);
  const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
  const id = row?.node_id ?? row?.nodeId;
  const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
  return nodes.find((n) => n.id === id)?.prefix ?? null;
};

try {
  KEY = JSON.parse((await req("POST", "/api/keys", { name: "p4-fastest" })).body).key;
  await req("PUT", "/api/settings", { requireApiKey: true, budgetUsdPerDay: 0 });

  await ensureNode("p4slow", SLOW);
  await ensureNode("p4fast", FAST);

  // declare slow FIRST so a correct result can only come from latency learning
  const combos = JSON.parse((await req("GET", "/api/combos")).body);
  const existing = combos.find((c) => c.name === "p4fastest");
  const spec = { name: "p4fastest", models: ["p4slow/m", "p4fast/m"], strategy: "fastest" };
  if (existing) await req("PUT", `/api/combos/${existing.id}`, { models: spec.models, strategy: spec.strategy });
  else await req("POST", "/api/combos", spec);

  const picks = [];
  for (let i = 0; i < 6; i++) {
    const r = await ask("p4fastest");
    picks.push(await lastNode());
    if (r.status !== 200) throw new Error(`request ${i} failed: ${r.status} ${r.body.slice(0, 120)}`);
  }
  console.log(`picks over 6 requests: ${picks.join(" -> ")}`);
  check("both upstreams get explored", picks.includes("p4slow") && picks.includes("p4fast"), picks.join(","));
  check("after learning, the fast node is preferred", picks[picks.length - 1] === "p4fast", `last=${picks[picks.length - 1]}`);

  // the latency difference must be visible in the recorded usage
  const rows = JSON.parse((await req("GET", "/api/usage/history?limit=10")).body);
  const list = Array.isArray(rows) ? rows : rows.rows ?? [];
  const slowId = (await nodeByPrefix("p4slow")).id;
  const fastId = (await nodeByPrefix("p4fast")).id;
  const slowTtft = list.find((r) => r.node_id === slowId)?.ttft_ms;
  const fastTtft = list.find((r) => r.node_id === fastId)?.ttft_ms;
  check("measured TTFT separates the two upstreams", fastTtft < slowTtft, `fast=${fastTtft}ms slow=${slowTtft}ms`);
} catch (err) {
  check("verification crashed", false, String(err?.stack || err).slice(0, 300));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
