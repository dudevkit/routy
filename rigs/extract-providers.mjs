import { readdirSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
import path from "path";

const regDir = path.join(process.cwd(), "9router", "open-sse", "providers", "registry");
const files = readdirSync(regDir).filter(f => f.endsWith(".js") && !f.startsWith("index") && f !== "REGISTRY_TEMPLATE.js");

const out = [];
const failed = [];
for (const f of files.sort()) {
  try {
    const mod = await import(pathToFileURL(path.join(regDir, f)).href);
    const p = mod.default;
    if (!p) { failed.push(f); continue; }
    out.push({
      file: f,
      id: p.id,
      name: p.display?.name || p.id,
      alias: p.alias || p.id,
      aliases: p.aliases,
      category: p.category,
      authType: p.authType || (p.hasOAuth ? "oauth" : p.noAuth ? "none" : "apikey"),
      hasOAuth: !!p.hasOAuth,
      noAuth: !!p.noAuth,
      baseUrl: p.transport?.baseUrl || "",
      format: p.transport?.format || "openai",
      executor: p.transport?.executor || "default",
      forceStream: !!p.transport?.forceStream,
      urlSuffix: p.transport?.urlSuffix || "",
      quirks: p.transport?.quirks ? Object.keys(p.transport.quirks) : [],
      oauthKeys: p.oauth ? Object.keys(p.oauth) : null,
      oauthUrls: p.oauth ? {
        authorize: p.oauth.authorizeUrl || "",
        token: p.oauth.tokenUrl || "",
        device: p.oauth.deviceCodeUrl || "",
        refresh: p.oauth.refreshUrl || "",
        scopes: p.oauth.scope || p.oauth.scopes || "",
      } : null,
      models: Array.isArray(p.models) ? p.models.length : "none",
      modelIds: Array.isArray(p.models) ? p.models.map(m => m.id) : [],
      serviceKinds: p.serviceKinds || null,
      media: p.media ? Object.keys(p.media) : null,
      passthroughModels: !!p.passthroughModels,
      features: p.features ? Object.keys(p.features) : null,
      website: p.display?.website || "",
      apiKeyUrl: p.display?.notice?.apiKeyUrl || "",
      deprecated: !!p.display?.deprecated,
    });
  } catch (e) {
    failed.push(`${f}: ${e.message.split("\n")[0]}`);
  }
}

writeFileSync("rigs/providers.json", JSON.stringify(out, null, 2));
console.log(`extracted: ${out.length}, failed: ${failed.length}`);
if (failed.length) console.log("FAILED:\n" + failed.slice(0, 10).join("\n"));
const cats = {};
for (const p of out) cats[p.category] = (cats[p.category] || 0) + 1;
console.log("categories:", JSON.stringify(cats));
const execs = {};
for (const p of out) execs[p.executor] = (execs[p.executor] || 0) + 1;
console.log("executors:", JSON.stringify(execs));
const fmts = {};
for (const p of out) fmts[p.format] = (fmts[p.format] || 0) + 1;
console.log("formats:", JSON.stringify(fmts));
const oauthProviders = out.filter(p => p.hasOAuth).map(p => p.id);
console.log("oauth providers:", oauthProviders.length, "→", oauthProviders.join(", "));
const mediaProviders = out.filter(p => p.media).map(p => `${p.id}[${p.media.join("+")}]`);
console.log("media providers:", mediaProviders.length, "→", mediaProviders.join(", "));
