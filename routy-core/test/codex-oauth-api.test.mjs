import { it, expect, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { buildApiRoutes } from "../http/api.mjs";
import { createRouter } from "../lib/router.mjs";

it("requires the matching state and commits Codex accounts only once", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-api-"));
  const db = openDatabase(tmp), repos = createRepos(db);
  repos.settings.update({ requireApiKey: false });
  const dispatch = createRouter(buildApiRoutes(repos, { bootstrapToken: "test" }, "test"));
  const server = http.createServer((req, res) => dispatch(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const post = (url, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: url, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-routy-action": "1" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject); req.end(data);
  });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  try {
    const started = await post("/api/providers/codex/oauth/start", { intent: "create", name: "Codex", prefix: "cx" });
    expect(started.status).toBe(200);
    const state = new URL(started.body.verificationUrl).searchParams.get("state");
    const base = `/api/providers/codex/oauth/flows/${started.body.flowId}`;
    expect((await post(`${base}/callback`, { code: "code", state: "wrong" })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect((await post(`${base}/callback`, { code: "code", state })).status).toBe(200);
    expect((await post(`${base}/poll`, {})).body.state).toBe("complete");
    expect(repos.nodes.byPrefix("cx").data.authProvider).toBe("codex-oauth");
    expect((await post(`${base}/callback`, { code: "code", state })).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    repos.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
