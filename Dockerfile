# RE-E gateway image — multi-stage; the runtime layer carries the single-file
# bundle and nothing else (no node_modules, no build tools).
#
#   docker build -t re-e .
#   docker run -p 8010:8010 -v re-e-data:/data re-e
#
# Node 24 is used because it loads the built-in node:sqlite without a flag
# (22.5–23.3 need --experimental-sqlite).

# ── dashboard ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS ui
WORKDIR /src/re-e-ui
COPY re-e-ui/package.json re-e-ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY re-e-ui/ ./
RUN npm run build

# ── bundle ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS bundle
WORKDIR /src
COPY re-e-core/package.json re-e-core/package-lock.json ./re-e-core/
RUN npm --prefix re-e-core ci --no-audit --no-fund
COPY re-e-core/ ./re-e-core/
COPY --from=ui /src/re-e-ui/dist ./re-e-ui/dist
RUN node re-e-core/scripts/build.mjs --minify

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine
# A container must listen beyond loopback to be reachable; non-loopback peers
# therefore need the bootstrap token for /api and a valid key for /v1.
ENV NODE_ENV=production \
    RE_E_HOME=/data \
    RE_E_HOST=0.0.0.0 \
    RE_E_PORT=8010
WORKDIR /app
COPY --from=bundle /src/re-e-core/dist/ ./
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8010
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RE_E_PORT||8010)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/re-e.mjs"]
CMD ["serve"]
