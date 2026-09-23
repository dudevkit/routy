// P5 — single-file bundle for shipping.
//
// Bundles the CLI + gateway + undici into one ESM file so a host needs nothing but
// Node 22.5+ (the built-in node:sqlite) and no npm install. `node:sqlite` stays
// external because it is a builtin; everything else, including the translator tree
// and undici, is inlined.
//
// Usage: node scripts/build.mjs [--minify] [--out dist/routy.mjs]
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repo = path.resolve(root, "..");

const argv = process.argv.slice(2);
const minify = argv.includes("--minify");
const outFlag = argv.indexOf("--out");
const outfile = path.resolve(root, outFlag >= 0 ? argv[outFlag + 1] : "dist/routy.mjs");

fs.mkdirSync(path.dirname(outfile), { recursive: true });

// One source for the version: package.json. Inlined because a bundle has no source
// tree to read it from at runtime (lib/version.mjs).
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const result = await build({
  entryPoints: [path.join(root, "bin", "routy.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify,
  define: { __ROUTY_VERSION__: JSON.stringify(pkg.version) },
  // Readable output by default: the point is a small dependency surface, not a
  // mangled file nobody can debug. --minify is there for release builds.
  keepNames: true,
  legalComments: "none",
  banner: {
    // undici (and other CJS deps) call require() for builtins; in ESM output esbuild
    // rewrites those to __require, which throws unless a real require exists.
    js: `#!/usr/bin/env node
import { createRequire as __reCreateRequire } from "node:module";
const require = __reCreateRequire(import.meta.url);`,
  },
  // node:sqlite and friends are builtins; undici is deliberately inlined so the
  // bundle has no runtime dependency at all.
  external: [],
  metafile: true,
  logLevel: "warning",
});

const bytes = fs.statSync(outfile).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`built ${path.relative(repo, outfile)}`);
console.log(`  size    : ${(bytes / 1024).toFixed(0)} KB${minify ? " (minified)" : ""}`);
console.log(`  modules : ${inputs} inlined`);

// Ship the dashboard alongside the bundle when it has been built. The gateway
// resolves <bundleDir>/ui without any env var (lib/config.mjs).
const uiSrc = path.join(repo, "routy-ui", "dist");
const uiDest = path.join(path.dirname(outfile), "ui");
if (fs.existsSync(path.join(uiSrc, "index.html"))) {
  fs.rmSync(uiDest, { recursive: true, force: true });
  fs.cpSync(uiSrc, uiDest, { recursive: true });
  console.log(`  ui      : copied routy-ui/dist -> ${path.relative(repo, uiDest)}`);
} else {
  console.log("  ui      : routy-ui/dist not built — bundle serves no dashboard (set ROUTY_UI_DIR)");
}
