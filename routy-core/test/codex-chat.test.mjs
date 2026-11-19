import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/driver.mjs";
import { createRepos } from "../db/repos.mjs";
import { createChatHandler } from "../core/handlers/chat.mjs";
import { CodexExecutor } from "../core/executors/codex.mjs";

describe("Codex Responses without a content-type header", () => {
  it.each([true, false])("returns text to an OpenAI client (stream=%s)", async (stream) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routy-codex-chat-"));
    const db = openDatabase(tmp);
    const repos = createRepos(db);
    repos.settings.update({ requireApiKey: false });
    repos.oauth.createNodeWithConnection({ name: "Codex", prefix: "cx", baseUrl: "https://example.invalid", data: { authProvider: "codex-oauth" }, connection: { name: "account", credentials: { authType: "oauth", authState: "active", accessToken: "stub", expiresAt: "2099-01-01T00:00:00.000Z", lastRefreshAt: "2099-01-01T00:00:00.000Z" } } });
    const events = [{ type: "response.created" }, { type: "response.output_text.delta", delta: "Hello" }, { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const spy = vi.spyOn(CodexExecutor.prototype, "execute").mockImplementation(async () => ({ ok: true, response: new Response(events, { status: 200, headers: { "content-type": "application/octet-stream" } }) }));
    const handler = createChatHandler(repos);
    const server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "cx/gpt-6-luna", messages: [{ role: "user", content: "hello" }], stream }) });
      expect(response.status).toBe(200);
      if (stream) {
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(await response.text()).toContain('"content":"Hello"');
      } else {
        expect((await response.json()).choices[0].message.content).toBe("Hello");
      }
    } finally {
      spy.mockRestore(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); repos.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
