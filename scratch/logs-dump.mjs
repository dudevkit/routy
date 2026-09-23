// Dump raw /api/logs/stream bytes with a hard cap — no end-await.
import http from "node:http";
http.get({ host: "127.0.0.1", port: 8012, path: "/api/logs/stream" }, (res) => {
  console.log("status:", res.statusCode, "| ct:", res.headers["content-type"]);
  let d = "";
  res.on("data", (c) => (d += c.toString()));
  setTimeout(() => {
    console.log("captured bytes:", d.length);
    console.log("head:", JSON.stringify(d.slice(0, 400)));
    process.exit(0);
  }, 1500);
}).on("error", (e) => { console.log("ERR", e.message); process.exit(0); });
