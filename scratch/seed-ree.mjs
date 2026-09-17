// Seed a demo node + alias + combo into the live re-e-core db (WAL: multi-process safe).
// Usage: node scratch/seed-ree.mjs
import { openDatabase } from "../re-e-core/db/driver.mjs";
import { createRepos } from "../re-e-core/db/repos.mjs";
import path from "node:path";

const db = openDatabase(path.resolve("scratch/ree-home/data"));
const repos = createRepos(db);

if (!repos.nodes.byPrefix("demo")) {
  repos.nodes.create({ name: "Demo Stub", prefix: "demo", apiType: "openai", baseUrl: "http://127.0.0.1:20990/v1" });
  repos.connections.create({ nodeId: repos.nodes.byPrefix("demo").id, name: "demo key", credentials: { apiKey: "bench-key" } });
  repos.aliases.set("smart", "demo/test-model");
  repos.combos.create({ name: "dev-combo", models: ["demo/test-model"] });
  console.log("seeded: node 'demo' + alias 'smart' + combo 'dev-combo'");
} else {
  console.log("already seeded");
}
db.close();
