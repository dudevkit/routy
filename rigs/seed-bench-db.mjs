// P0.4 seed — inserts bench node + connection + open settings into a fresh upstream db.
// Run AFTER first boot of the isolated instance (schema created), BEFORE benching.
// Usage: node --experimental-sqlite rigs/seed-bench-db.mjs
import { DatabaseSync } from "node:sqlite";
import path from "path";

const DATA_DIR = path.resolve("rigs/bench-data");
const db = new DatabaseSync(path.join(DATA_DIR, "db", "data.sqlite"));
db.exec("PRAGMA busy_timeout = 5000");

const now = new Date().toISOString();
const nodeId = "openai-compatible-chat-bench1";

db.prepare(
  `INSERT OR REPLACE INTO providerNodes (id, type, name, data, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(
  nodeId, "openai-compatible", "Bench Stub",
  JSON.stringify({ prefix: "bench", apiType: "chat", baseUrl: "http://127.0.0.1:20990/v1" }),
  now, now,
);

db.prepare(
  `INSERT OR REPLACE INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, NULL, 100, 1, ?, ?, ?)`
).run(
  "conn-bench1", nodeId, "apikey", "Bench Key",
  JSON.stringify({ apiKey: "bench-key", providerSpecificData: { baseUrl: "http://127.0.0.1:20990/v1", apiType: "chat" } }),
  now, now,
);

const existing = db.prepare("SELECT data FROM settings WHERE id = 1").get();
const settings = existing ? JSON.parse(existing.data) : {};
settings.requireApiKey = false;
settings.rtkEnabled = false; // bench the raw path; RTK bench is separate
db.prepare(
  `INSERT INTO settings (id, data) VALUES (1, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data`
).run(JSON.stringify(settings));

console.log("seeded: node + connection + settings(requireApiKey=false, rtk=false)");
db.close();
