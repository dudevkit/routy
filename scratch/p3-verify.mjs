// P3 live verification — drives a real gateway (started via scripts/re-e-serve.cmd)
// against the chaos stub and reports each stability property.
// Usage: node scratch/p3-verify.mjs <gatewayPort> <homeDir> [phase]
//   phase=main (default) → stall/die/slow/big/concurrency checks
//   phase=drain          → start a long stream, trigger shutdown, prove it drained
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const GW = Number(process.argv[2] || 8015);
const HOME = process.argv[3] || path.join(process.cwd(), "scratch", "chaos-home");
const PHASE = process.argv[4] || "main";
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

let API_KEY = null;

function req(method, p, body, port = GW, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { "content-type": "application/json" };
    if (payload) headers["content-length"] = Buffer.byteLength(payload);
    if (API_KEY && p.startsWith("/v1")) headers.authorization = `Bearer ${API_KEY}`;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, body: "ERR timeout" }); });
    r.end(payload ?? undefined);
  });
}

function gatewayPid() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, "gateway.lock"), "utf8")).pid; } catch { return null; }
}

function rssMb(pid) {
  if (!pid) return null;
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" });
    if (/No tasks|INFO:/i.test(out)) return null;
    const cols = out.trim().split('","');
    const mem = cols[cols.length - 1]?.replace(/[^\d]/g, "");
    return mem ? Math.round(parseInt(mem, 10) / 1024) : null;
  } catch { return null; }
}

const streamBody = (model) => ({ model, stream: true, messages: [{ role: "user", content: "hello" }] });

async function ensureNode() {
  // /v1 needs a real key while requireApiKey is on (the default)
  const created = await req("POST", "/api/keys", { name: "p3-verify" });
  if (created.status === 201) API_KEY = JSON.parse(created.body).key;
  if (!API_KEY) throw new Error(`could not mint an API key: ${created.status} ${created.body}`);

  const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
  let node = nodes.find((n) => n.prefix === "chaos");
  if (!node) {
    const r = await req("POST", "/api/nodes", { name: "Chaos", baseUrl: "http://127.0.0.1:20995/v1", apiKey: "chaos-key", prefix: "chaos" });
    if (r.status !== 201) throw new Error(`node create failed: ${r.status} ${r.body}`);
    node = JSON.parse(r.body);
  }
  // 1.5s watchdog so a stall is provable without a long test
  await req("PUT", `/api/nodes/${node.id}`, { data: { streamIdleTimeoutMs: 1500 } });
  return node;
}

const resetBreaker = (node) => req("POST", `/api/nodes/${node.id}/reset`, {});

async function main() {
  const node = await ensureNode();
  console.log(`gateway :${GW}  node ${node.prefix} (${node.id})  pid=${gatewayPid()}\n`);

  // 1. healthy stream still works
  await resetBreaker(node);
  const ok = await req("POST", "/v1/chat/completions", streamBody("chaos/ok"));
  check("healthy stream completes", ok.status === 200 && ok.body.trim().endsWith("data: [DONE]"), `${ok.status}, ${ok.body.length}B`);

  // 2. stall watchdog
  await resetBreaker(node);
  const t0 = Date.now();
  const stall = await req("POST", "/v1/chat/completions", streamBody("chaos/stall"));
  const stallMs = Date.now() - t0;
  check("stall → terminal error frame", stall.status === 200 && stall.body.includes("upstream_stalled"), `${stallMs}ms (watchdog 1500ms)`);
  check("stall → bounded, not hung", stallMs < 6000, `${stallMs}ms`);
  const afterStall = JSON.parse((await req("GET", "/api/nodes")).body).find((n) => n.id === node.id);
  check("stall → breaker counts a failure", afterStall.status === "degraded" && afterStall.lastError?.includes("upstream_stalled"), `status=${afterStall.status} lastError=${afterStall.lastError}`);

  // 3. upstream dies mid-stream
  await resetBreaker(node);
  const die = await req("POST", "/v1/chat/completions", streamBody("chaos/die"));
  check("upstream death → error frame", die.status === 200 && die.body.includes("before-crash") && die.body.includes("upstream_stream_failed"), `${die.body.length}B`);

  // 4. slow-but-alive stream is not killed by the watchdog
  await resetBreaker(node);
  const slow = await req("POST", "/v1/chat/completions", streamBody("chaos/slow"));
  check("slow stream survives watchdog (not a deadline)", slow.status === 200 && slow.body.trim().endsWith("data: [DONE]") && !slow.body.includes("upstream_stalled"), `${slow.body.length}B`);

  // 5. big stream — client gets everything, gateway RSS stays bounded
  await resetBreaker(node);
  const pid = gatewayPid();
  const before = rssMb(pid);
  const big = await req("POST", "/v1/chat/completions", streamBody("chaos/big"), GW, 120_000);
  const after = rssMb(pid);
  check("6MB stream delivered in full", big.status === 200 && big.body.trim().endsWith("data: [DONE]") && big.body.length > 5_000_000, `${(big.body.length / 1e6).toFixed(1)}MB`);
  check("RSS bounded after big stream", before === null || after === null || after - before < 150, `before=${before}MB after=${after}MB delta=${after - before}MB`);

  // 6. concurrent load
  await resetBreaker(node);
  const t1 = Date.now();
  const many = await Promise.all(Array.from({ length: 20 }, () => req("POST", "/v1/chat/completions", streamBody("chaos/ok"), GW, 60_000)));
  const allOk = many.every((r) => r.status === 200 && r.body.trim().endsWith("data: [DONE]"));
  check("20 concurrent streams all complete", allOk, `${Date.now() - t1}ms`);

  // 7. usage recorded for the whole run
  const stats = JSON.parse((await req("GET", "/api/usage/stats")).body);
  check("usage recorded", (stats.requestsToday ?? 0) >= 24, `requestsToday=${stats.requestsToday} errRate=${stats.errorRatePct}%`);
  const failures = JSON.parse((await req("GET", "/api/usage/failures")).body);
  check("failures surfaced to the UI", Array.isArray(failures) && failures.length >= 1, `${failures.length} failure rows`);
}

async function drain() {
  const pid = gatewayPid();
  console.log(`gateway :${GW} pid=${pid} — long stream + shutdown\n`);
  const node = await ensureNode();
  await resetBreaker(node);

  const longPromise = req("POST", "/v1/chat/completions", streamBody("chaos/long"), GW, 60_000);
  await new Promise((r) => setTimeout(r, 1500)); // let it get going

  const shutdown = await req("POST", "/api/gateway/shutdown", {});
  check("shutdown accepted (202)", shutdown.status === 202, `${shutdown.status} ${shutdown.body}`);

  const long = await longPromise;
  const frames = (long.body.match(/"content":" long\d+"/g) || []).length;
  check("in-flight stream drained to completion", long.status === 200 && long.body.trim().endsWith("data: [DONE]"), `${frames} chunks, ${long.body.length}B`);
  check("drained stream was not truncated early", frames === 40, `${frames}/40 chunks`);

  // process should exit on its own, releasing the lock
  let exited = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (rssMb(pid) === null) { exited = true; break; }
  }
  check("gateway exited after drain", exited, `pid ${pid}`);
  check("lockfile released", !fs.existsSync(path.join(HOME, "gateway.lock")), path.join(HOME, "gateway.lock"));
}

async function trip() {
  const node = await ensureNode();
  await resetBreaker(node);
  for (let i = 0; i < 3; i++) await req("POST", "/v1/chat/completions", streamBody("chaos/die"));
  const view = JSON.parse((await req("GET", "/api/nodes")).body).find((n) => n.id === node.id);
  check("3 consecutive failures trip the breaker", view.status === "down", `status=${view.status}`);
  const blocked = await req("POST", "/v1/chat/completions", streamBody("chaos/ok"));
  check("open breaker refuses to hammer the upstream", blocked.status === 503 && blocked.body.includes("all_unavailable"), `${blocked.status}`);
}

async function verifyDown() {
  await ensureNode(); // mint a key + resolve the node; does not touch the breaker
  const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
  const node = nodes.find((n) => n.prefix === "chaos");
  check("breaker survived the restart", node?.status === "down", `status=${node?.status} lastError=${node?.lastError}`);
  const blocked = await req("POST", "/v1/chat/completions", streamBody("chaos/ok"));
  check("still refusing after restart", blocked.status === 503 && blocked.body.includes("all_unavailable"), `${blocked.status} ${blocked.body.slice(0, 80)}`);
  const reset = await req("POST", `/api/nodes/${node.id}/reset`, {});
  check("manual reset clears the breaker", reset.status === 200 && JSON.parse(reset.body).status === "healthy", `status=${JSON.parse(reset.body).status}`);
  const ok = await req("POST", "/v1/chat/completions", streamBody("chaos/ok"));
  check("healthy again after reset", ok.status === 200 && ok.body.trim().endsWith("data: [DONE]"), `${ok.status}`);
}

try {
  if (PHASE === "drain") await drain();
  else if (PHASE === "trip") await trip();
  else if (PHASE === "verify-down") await verifyDown();
  else await main();
} catch (err) {
  check("verification crashed", false, String(err?.stack || err).slice(0, 400));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
