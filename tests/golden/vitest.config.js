import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const R9 = path.join(ROOT, "..", "..", "9router");

process.env.DATA_DIR = path.join(ROOT, ".tmp-data");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^open-sse\/(.*)$/, replacement: path.join(R9, "open-sse/$1") },
      { find: /^@\/(.*)$/, replacement: path.join(R9, "src/$1") },
    ],
  },
  test: {
    include: ["*.test.js"],
    environment: "node",
  },
});
