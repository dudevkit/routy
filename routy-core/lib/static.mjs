// routy static file serving — /ui/* SPA host (routy-ui dist) with SPA fallback.
// Zero deps; extension → content-type map; traversal-guarded.
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve a file from rootDir for urlPath. Returns false when nothing was served
 * (caller decides fallback). Guards traversal; SPA-fallbacks extension-less GETs.
 */
export function serveStatic(res, rootDir, urlPath, { spaFallback = true } = {}) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return false;
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  if (rel === "" || rel === "/") rel = "index.html";
  let file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) && file !== root) return false;

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const ext = path.extname(rel);
    if (!spaFallback || ext !== "") return false; // real missing asset → 404 by caller
    file = path.join(root, "index.html");
    if (!fs.existsSync(file)) return false;
  }

  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=86400" });
  fs.createReadStream(file).pipe(res);
  return true;
}
