// P5 — smoke the built artifact, not the source tree.
//
// Boots dist/re-e.mjs as a real gateway (fresh RE_E_HOME, its own port), drives a
// streaming request through a stub upstream, checks the dashboard is served from
// <bundleDir>/ui, then shuts it down gracefully. Exits non-zero on any failure.
//
// Usage: node scripts/smoke.mjs [--bundle dist/re-e.mjs]
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const outFlag = argv.indexOf("--bundle");
const bundle = path.resolve(root, outFlag >= 0 ? argv[outFlag + 1] : "dist/re-e.mjs");

const PORT = 8119;
const STUB_PORT = 21119;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ree-smoke-"));

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function req(method, p, body, port = PORT) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) }, timeout: 20_000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    r.on("error", (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, body: "ERR timeout" }); });
    r.end(payload ?? undefined);
  });
}

const waitFor = async (fn, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

// ── stub upstream ────────────────────────────────────────────────────────────
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"smoke"},"finish_reason":null}]}\n\n`);
    res.write(`data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

let child = null;
try {
  check("bundle exists", fs.existsSync(bundle), path.relative(root, bundle));
  check("dashboard shipped next to the bundle", fs.existsSync(path.join(path.dirname(bundle), "ui", "index.html")), path.join(path.dirname(bundle), "ui"));
  if (!fs.existsSync(bundle)) throw new Error("no bundle to smoke — run npm run build first");

  await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

  // boot the artifact itself
  child = spawn(process.execPath, [bundle, "serve"], {
    cwd: HOME, // deliberately NOT the repo: proves no source-tree dependency
    env: { ...process.env, RE_E_HOME: HOME, RE_E_PORT: String(PORT), RE_E_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));

  const booted = await waitFor(async () => (await req("GET", "/api/health")).status === 200);
  check("boots from an unrelated cwd", booted, booted ? "health ok" : out.slice(-300));
  check("created its own state dir", fs.existsSync(path.join(HOME, "data", "re-e.db")));

  const health = await req("GET", "/api/health");
  check("health reports ok", health.status === 200 && JSON.parse(health.body).status === "ok");

  const metrics = await req("GET", "/metrics");
  check("metrics served", metrics.status === 200 && metrics.body.includes("re_e_build_info"));

  // dashboard from <bundleDir>/ui
  const ui = await req("GET", "/");
  check("dashboard served from the bundle dir", ui.status === 200 && ui.body.includes("<div id=\"root\""), `${ui.status} ${(ui.headers["content-type"] ?? "").split(";")[0]}`);

  // a real routed request
  const node = await req("POST", "/api/nodes", { name: "Smoke", prefix: "smoke", baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, apiKey: "k" });
  check("node created through the API", node.status === 201, `${node.status}`);
  const nodeId = JSON.parse(node.body).id;
  await req("POST", `/api/nodes/${nodeId}/connections`, { name: "k", apiKey: "k" });
  await req("PUT", "/api/settings", { requireApiKey: false });

  const chat = await req("POST", "/v1/chat/completions", { model: "smoke/m", stream: true, messages: [{ role: "user", content: "hi" }] });
  check("streams a completion through the bundle", chat.status === 200 && chat.body.includes("smoke") && chat.body.trim().endsWith("data: [DONE]"), `${chat.status}`);

  const usage = await req("GET", "/api/usage/stats");
  check("usage recorded", JSON.parse(usage.body).requestsToday >= 1, `requestsToday=${JSON.parse(usage.body).requestsToday}`);

  // graceful stop through the gateway's own endpoint
  const stop = await req("POST", "/api/gateway/shutdown", {});
  check("shutdown accepted", stop.status === 202, `${stop.status}`);
  const exited = await waitFor(async () => child.exitCode !== null, 12_000);
  check("exits cleanly on shutdown", exited && child.exitCode === 0, `exitCode=${child.exitCode}`);
  check("lockfile released", !fs.existsSync(path.join(HOME, "gateway.lock")));
} catch (err) {
  check("smoke crashed", false, String(err?.message || err));
} finally {
  if (child && child.exitCode === null) child.kill();
  stub.closeAllConnections?.();
  await new Promise((r) => stub.close(r));
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
