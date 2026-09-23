# routy gateway image — multi-stage; the runtime layer carries the single-file
# bundle and nothing else (no node_modules, no build tools).
#
#   docker build -t routy .
#   docker run -p 8010:8010 -v routy-data:/data routy
#
# Node 24 is used because it loads the built-in node:sqlite without a flag
# (22.5–23.3 need --experimental-sqlite).

# ── dashboard ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS ui
WORKDIR /src/routy-ui
COPY routy-ui/package.json routy-ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY routy-ui/ ./
RUN npm run build

# ── bundle ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS bundle
WORKDIR /src
COPY routy-core/package.json routy-core/package-lock.json ./routy-core/
RUN npm --prefix routy-core ci --no-audit --no-fund
COPY routy-core/ ./routy-core/
COPY --from=ui /src/routy-ui/dist ./routy-ui/dist
RUN node routy-core/scripts/build.mjs --minify

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine
# A container must listen beyond loopback to be reachable; non-loopback peers
# therefore need the bootstrap token for /api and a valid key for /v1.
ENV NODE_ENV=production \
    ROUTY_HOME=/data \
    ROUTY_HOST=0.0.0.0 \
    ROUTY_PORT=8010
WORKDIR /app
COPY --from=bundle /src/routy-core/dist/ ./
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8010
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ROUTY_PORT||8010)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/routy.mjs"]
CMD ["serve"]
