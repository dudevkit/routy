// P4 live verification — combo strategy ordering, metered cost, daily budget,
// and the metrics endpoint against a real gateway.
// Usage: node scratch/p4-verify.mjs [gatewayPort] [stubPort]
import http from "node:http";

const GW = Number(process.argv[2] || 8015);
const STUB = Number(process.argv[3] || 20995);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

let API_KEY = null;
function req(method, p, body, port = GW) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { "content-type": "application/json" };
    if (payload) headers["content-length"] = Buffer.byteLength(payload);
    if (API_KEY && (p.startsWith("/v1") || p.startsWith("/api"))) headers.authorization = `Bearer ${API_KEY}`;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: 60_000 }, (res) => {
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

async function ensureKey() {
  const created = await req("POST", "/api/keys", { name: "p4-verify" });
  if (created.status !== 201) throw new Error(`key mint failed: ${created.status} ${created.body}`);
  API_KEY = JSON.parse(created.body).key;
}

async function resetSettings() {
  await req("PUT", "/api/settings", { requireApiKey: true, budgetUsdPerDay: 0 });
}

/** Create (or replace) a node named prefix, returning its id. */
async function ensureNode(prefix, data) {
  const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
  const existing = nodes.find((n) => n.prefix === prefix);
  if (existing) {
    await req("PUT", `/api/nodes/${existing.id}`, { data });
    return existing.id;
  }
  const r = await req("POST", "/api/nodes", { name: prefix, prefix, baseUrl: `http://127.0.0.1:${STUB}/v1`, apiKey: "k", data });
  if (r.status !== 201) throw new Error(`node ${prefix} create failed: ${r.status} ${r.body}`);
  return JSON.parse(r.body).id;
}

async function ensureCombo(name, models, strategy) {
  const combos = JSON.parse((await req("GET", "/api/combos")).body);
  const existing = combos.find((c) => c.name === name);
  if (existing) {
    await req("PUT", `/api/combos/${existing.id}`, { models, strategy });
    return existing.id;
  }
  const r = await req("POST", "/api/combos", { name, models, strategy });
  if (r.status !== 201) throw new Error(`combo create failed: ${r.status} ${r.body}`);
  return JSON.parse(r.body).id;
}

const lastNodeId = () => req("GET", "/api/usage/history?limit=1").then((r) => {
  const rows = JSON.parse(r.body);
  const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
  return row?.node_id ?? row?.nodeId ?? null;
});

const nodePrefixById = async (id) => {
  const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
  return nodes.find((n) => n.id === id)?.prefix ?? null;
};

try {
  await ensureKey();
  await resetSettings();

  // ── 1. strategy ordering ──────────────────────────────────────────────────
  await ensureNode("p4dear", { pricing: { inputPer1M: 50, outputPer1M: 50 } });
  await ensureNode("p4cheap", { pricing: { inputPer1M: 1, outputPer1M: 1 } });
  await ensureNode("p4free", {});
  for (const p of ["p4dear", "p4cheap", "p4free"]) {
    const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
    const n = nodes.find((x) => x.prefix === p);
    const conns = JSON.parse((await req("GET", `/api/nodes/${n.id}/connections`)).body);
    if (!conns.length) await req("POST", `/api/nodes/${n.id}/connections`, { name: "k", apiKey: "k" });
  }

  await ensureCombo("p4fallback", ["p4dear/m", "p4cheap/m", "p4free/m"], "fallback");
  await ensureCombo("p4cheapest", ["p4dear/m", "p4cheap/m", "p4free/m"], "cheapest");

  await ask("p4fallback");
  const fallbackPick = await nodePrefixById(await lastNodeId());
  check("fallback keeps declared order (dearest first)", fallbackPick === "p4dear", `served by ${fallbackPick}`);

  await ask("p4cheapest");
  const cheapestPick = await nodePrefixById(await lastNodeId());
  check("cheapest picks the unmetered node", cheapestPick === "p4free", `served by ${cheapestPick}`);

  await ensureCombo("p4fastest", ["p4dear/m", "p4cheap/m"], "fastest");
  const fast = await req("POST", "/api/combos", { name: "p4fastest-bad", models: ["p4free/m"], strategy: "nonsense" });
  check("invalid strategy rejected with 400", fast.status === 400 && fast.body.includes("bad_request"), `${fast.status}`);

  // ── 2. metered cost ───────────────────────────────────────────────────────
  const stats = JSON.parse((await req("GET", "/api/usage/stats")).body);
  check("metered spend is tracked", typeof stats.costUsd7d === "number" && stats.costUsd7d > 0, `costUsd7d=${stats.costUsd7d}`);

  // ── 3. budget ceiling + auto-fallback ─────────────────────────────────────
  await req("PUT", "/api/settings", { budgetUsdPerDay: 0.000001 });
  const paidOnly = await ask("p4dear/m");
  const blocked = paidOnly.status === 200 ? await ask("p4dear/m") : paidOnly;
  check("metered-only traffic refused at the ceiling", blocked.status === 402 && blocked.body.includes("budget_exceeded"), `${blocked.status} ${blocked.body.slice(0, 90)}`);

  await ask("p4fallback");
  const fallbackAfterBudget = await nodePrefixById(await lastNodeId());
  check("exhausted budget falls through to the unmetered node", fallbackAfterBudget === "p4free", `served by ${fallbackAfterBudget}`);

  await resetSettings();
  const afterReset = await ask("p4dear/m");
  check("raising the ceiling restores metered routing", afterReset.status === 200, `${afterReset.status}`);

  // ── 4. metrics reflect all of it ──────────────────────────────────────────
  const metrics = await req("GET", "/metrics");
  const text = metrics.body;
  check("metrics endpoint serves Prometheus text", metrics.status === 200 && text.includes("# TYPE re_e_requests_total counter"), `${metrics.status}`);
  const value = (name, labels = "") => {
    const re = new RegExp(`^${name}${labels} (.+)$`, "m");
    return Number(text.match(re)?.[1]);
  };
  check("metrics count requests by status", value("re_e_requests_total", '\\{status="ok"\\}') > 0, `ok=${value("re_e_requests_total", '\\{status="ok"\\}')}`);
  check("metrics expose metered cost", value("re_e_cost_usd_total") > 0, `cost=${value("re_e_cost_usd_total")}`);
  check("metrics expose node state", value("re_e_nodes", '\\{status="healthy"\\}') >= 3, `healthy=${value("re_e_nodes", '\\{status="healthy"\\}')}`);
  check("metrics expose upstream pools", value("re_e_upstream_pools") >= 1, `pools=${value("re_e_upstream_pools")}`);
  check("metrics expose process gauges", value("re_e_process_resident_memory_bytes") > 0, `rss=${value("re_e_process_resident_memory_bytes")}`);
  check("metrics expose ttft summary", value("re_e_ttft_ms_count", '\\{node="[^"]+"\\}') > 0);
} catch (err) {
  check("verification crashed", false, String(err?.stack || err).slice(0, 300));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
