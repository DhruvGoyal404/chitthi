# Production image for the web app, built from the repo root (one workspace, one lockfile):
#   docker build -f web/Dockerfile -t chitthi-web .
# The Vite build is served by Caddy as a non-root user on :5175; the edge Caddy proxies to it.
# Base images pinned by multi-arch index digest: node 22.23.3 / Alpine 3.24 (pushed 2026-09-23),
# caddy 2.11.6 (pushed 2026-10-04; only its binary is used) and Alpine 3.24.2 (pushed 2026-09-18).
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG CADDY_IMAGE=caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9
ARG ALPINE_IMAGE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY api/package.json api/
COPY web/package.json web/
# No install scripts: Vite's and Tailwind's native parts are prebuilt platform packages.
RUN npm ci --workspace @chitthi/web --include-workspace-root --ignore-scripts
COPY web/tsconfig.json web/index.html web/vite.config.ts web/
COPY web/public web/public
COPY web/src web/src
# Typechecking (src, e2e and configs) is CI's job; the image only needs the bundle.
RUN cd web && ../node_modules/.bin/vite build \
 && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) -exec gzip -9 -k {} +

# The stock binary carries a cap_net_bind_service file capability (for ports below 1024), and with
# it exec fails outright under cap_drop: ALL. A plain copy has none; putting it on bare Alpine keeps
# the image from holding the binary twice.
FROM ${CADDY_IMAGE} AS caddy
RUN cat /usr/bin/caddy > /caddy && chmod 0755 /caddy

FROM ${ALPINE_IMAGE} AS web
RUN addgroup -S -g 10001 web && adduser -S -D -H -u 10001 -G web web
COPY --from=caddy /caddy /usr/bin/caddy
# Caddy would otherwise want to write under the home directory; with admin and persistence off
# it writes nothing, and /tmp is where a read-only container gets its tmpfs.
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/web/dist /srv
USER web
EXPOSE 5175
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:5175/ || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
