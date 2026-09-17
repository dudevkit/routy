// RE-E tiny router — raw Node req/res, zero deps.
// routes: [{ method, pattern: RegExp with named groups, handler(req, res, params, match) }]
// Handlers either fully respond, or return a Promise (errors → 500 JSON, no crash).
export function createRouter(routes) {
  return async function dispatch(req, res) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = pathname.match(route.pattern);
      if (!m) continue;
      try {
        await route.handler(req, res, m.groups || {}, url);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "internal_error", detail: String(err?.message || err) } }));
        } else {
          res.destroy();
        }
      }
      return true;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not_found", path: pathname } }));
    return false;
  };
}

export function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
