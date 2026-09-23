// R3-2/R3-4/R3-5 verification
import http from "node:http";
const req = (m, p, b) => new Promise((r) => {
  const payload = b ? JSON.stringify(b) : null;
  const q = http.request({ host: "127.0.0.1", port: 8012, path: p, method: m, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => r({ code: res.statusCode, body: d }));
  });
  q.on("error", (e) => r({ code: "ERR", body: e.message }));
  q.end(payload ?? undefined);
});

// R3-2: duplicate prefix
const dup = await req("POST", "/api/nodes", { name: "Dup", baseUrl: "http://127.0.0.1:20990/v1", apiKey: "k", prefix: "t" });
console.log("R3-2 dup prefix:", dup.code, JSON.parse(dup.body).error?.detail || "");

// R3-5: usageEventId present on details
const details = JSON.parse((await req("GET", "/api/usage/details?limit=5")).body);
const withId = details.filter((d) => d.usageEventId !== null && d.usageEventId !== undefined).length;
console.log(`R3-5 details: ${withId}/${details.length} rows carry usageEventId`);

// R3-4: disabled node does not route
const nodes = JSON.parse((await req("GET", "/api/nodes")).body);
const target = nodes[0].id;
await req("PUT", `/api/nodes/${target}`, { enabled: false });
const chat = await req("POST", "/v1/chat/completions", { model: `${nodes[0].prefix}/m1`, stream: true, messages: [{ role: "user", content: "x" }] });
console.log("R3-4 disabled node chat:", chat.code, JSON.parse(chat.body).error?.message || "");
await req("PUT", `/api/nodes/${target}`, { enabled: true });
const re = await req("POST", "/v1/chat/completions", { model: `${nodes[0].prefix}/m1`, stream: true, messages: [{ role: "user", content: "x" }] });
console.log("R3-4 re-enabled chat:", re.code);
