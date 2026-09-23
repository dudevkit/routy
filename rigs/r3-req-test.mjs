// R3-1 diagnosis: chat → then dump ring (hard-capped, no end-await).
import http from "node:http";
const req = (m, p, b) => new Promise((r) => {
  const payload = b ? JSON.stringify(b) : null;
  const q = http.request({ host: "127.0.0.1", port: 8012, path: p, method: m, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => r({ code: res.statusCode, body: d }));
  });
  q.on("error", (e) => r({ code: "ERR", body: e.message }));
  q.end(payload ?? undefined);
});

await req("PUT", "/api/settings", { requireApiKey: false });
await req("POST", "/v1/chat/completions", { model: "t2/m1", stream: true, messages: [{ role: "user", content: "second" }] });
await new Promise((r) => setTimeout(r, 400));

http.get({ host: "127.0.0.1", port: 8012, path: "/api/logs/stream" }, (res) => {
  let d = "";
  res.on("data", (c) => (d += c.toString()));
  setTimeout(() => {
    const init = d.match(/event: init\ndata: (.*)/);
    if (init) {
      const lines = JSON.parse(init[1]).lines;
      console.log("ring lines:", lines.length);
      for (const l of lines) {
        const p = JSON.parse(l);
        console.log(`  [${p.level}] ${p.tag}: ${String(p.msg).slice(0, 70)}`);
      }
    } else {
      console.log("no init. head:", JSON.stringify(d.slice(0, 200)));
    }
    process.exit(0);
  }, 1200);
}).on("error", (e) => { console.log("ERR", e.message); process.exit(0); });
