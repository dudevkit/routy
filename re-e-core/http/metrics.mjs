// Prometheus text exposition for RE-E (P4).
//
// Counters are read from the usage_events table rather than kept in the hot
// path: every completed request is already a row there, scrapes are rare, and
// this keeps per-request work at zero. Only live process/pool state is a gauge.
import { poolOrigins } from "../core/executors/pool.mjs";

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (obj) => {
  const parts = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return parts.length ? `{${parts.map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : "";
};

function family(name, type, help, samples) {
  if (!samples.length) return "";
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${samples.map((s) => `${name}${s.labels} ${s.value}`).join("\n")}\n`;
}

const nodeStatus = (repos, node) => {
  if (!node.enabled) return "disabled";
  const b = repos.breakers.get(`node:${node.id}`);
  if (b?.state === "open" && b.openUntil && Date.parse(b.openUntil) > Date.now()) return "down";
  if ((b?.failures || 0) > 0) return "degraded";
  return "healthy";
};

export function renderMetrics(repos, { version, inflight = 0, startedAt = Date.now(), windowMs = 0 } = {}) {
  const since = windowMs > 0 ? Date.now() - windowMs : 0;
  const out = [];

  const byStatus = repos.stats.requestsByStatus({ since });
  out.push(family("re_e_requests_total", "counter", "Completed requests by terminal status.",
    byStatus.map((r) => ({ labels: labels({ status: r.status }), value: r.n }))));

  const byNode = repos.stats.requestsByNode({ since });
  out.push(family("re_e_requests_by_node_total", "counter", "Completed requests by upstream node and status.",
    byNode.map((r) => ({ labels: labels({ node: r.node, status: r.status }), value: r.n }))));

  const totals = repos.stats.totals({ since });
  out.push(family("re_e_tokens_total", "counter", "Tokens observed, by direction.", [
    { labels: labels({ type: "prompt" }), value: totals.promptTokens },
    { labels: labels({ type: "completion" }), value: totals.completionTokens },
  ]));
  out.push(family("re_e_cost_usd_total", "counter", "Reported upstream cost in USD.",
    [{ labels: "", value: Number(totals.costUsd) || 0 }]));

  const ttft = repos.stats.ttftByNode({ since });
  out.push(family("re_e_ttft_ms_count", "counter", "Requests with a measured time-to-first-token, by node.",
    ttft.map((r) => ({ labels: labels({ node: r.node }), value: r.n }))));
  out.push(family("re_e_ttft_ms_sum", "counter", "Sum of measured time-to-first-token, in ms.",
    ttft.map((r) => ({ labels: labels({ node: r.node }), value: r.sum }))));
  out.push(family("re_e_ttft_ms_min", "gauge", "Minimum measured time-to-first-token, in ms.",
    ttft.map((r) => ({ labels: labels({ node: r.node }), value: r.min }))));
  out.push(family("re_e_ttft_ms_max", "gauge", "Maximum measured time-to-first-token, in ms.",
    ttft.map((r) => ({ labels: labels({ node: r.node }), value: r.max }))));

  const statusCounts = new Map();
  for (const n of repos.nodes.list()) {
    const s = nodeStatus(repos, n);
    statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
  }
  out.push(family("re_e_nodes", "gauge", "Configured upstream nodes by status.",
    [...statusCounts].map(([status, value]) => ({ labels: labels({ status }), value }))));

  const now = Date.now();
  const breakers = repos.breakers.all();
  out.push(family("re_e_breaker_failures", "gauge", "Consecutive failures recorded per breaker.",
    breakers.map((b) => ({ labels: labels({ scope: b.scope }), value: b.failures }))));
  out.push(family("re_e_breaker_open", "gauge", "1 while the breaker's cooldown is in effect.",
    breakers.map((b) => ({ labels: labels({ scope: b.scope }), value: b.state === "open" && b.openUntil && Date.parse(b.openUntil) > now ? 1 : 0 }))));

  out.push(family("re_e_inflight_requests", "gauge", "Requests currently being served.", [{ labels: "", value: inflight }]));
  out.push(family("re_e_upstream_pools", "gauge", "Open upstream connection pools (one per origin).", [{ labels: "", value: poolOrigins().length }]));
  out.push(family("re_e_uptime_seconds", "gauge", "Seconds since the gateway booted.", [{ labels: "", value: Math.round((now - startedAt) / 1000) }]));

  const mem = process.memoryUsage();
  out.push(family("re_e_process_resident_memory_bytes", "gauge", "Resident set size.", [{ labels: "", value: mem.rss }]));
  out.push(family("re_e_process_heap_used_bytes", "gauge", "V8 heap in use.", [{ labels: "", value: mem.heapUsed }]));
  out.push(family("re_e_process_heap_total_bytes", "gauge", "V8 heap reserved.", [{ labels: "", value: mem.heapTotal }]));
  out.push(family("re_e_process_external_bytes", "gauge", "Off-heap memory (buffers, streams).", [{ labels: "", value: mem.external }]));

  out.push(family("re_e_build_info", "gauge", "Build metadata; always 1.", [{ labels: labels({ version, name: "re-e-core" }), value: 1 }]));

  return out.filter(Boolean).join("");
}

export function createMetricsRoute(repos, version, gauges = {}) {
  return {
    method: "GET",
    pattern: /^\/metrics$/,
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const windowMs = Number(url.searchParams.get("windowMs") || 0);
      let body;
      try {
        body = renderMetrics(repos, { version, windowMs, ...gauges() });
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`# metrics render failed: ${err.message}\n`);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(body);
    },
  };
}
