# Production images for the API, built from the repo root (one workspace, one lockfile):
#   docker build -f api/Dockerfile --target api     -t chitthi-api .
#   docker build -f api/Dockerfile --target migrate -t chitthi-migrate .
# Base: node 22.23.3 on Alpine 3.24 (pushed 2026-09-23), pinned by multi-arch index digest. Alpine's
# musl allocator also avoids the glibc fragmentation sharp's docs warn about in long-lived processes.
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY api/package.json api/
COPY web/package.json web/
# The API workspace plus the root (typescript, dbmate). No install scripts: sharp and dbmate ship
# prebuilt platform packages, picked by npm from the lockfile.
RUN npm ci --workspace @chitthi/api --include-workspace-root --ignore-scripts
COPY api/tsconfig.json api/tsconfig.build.json api/
COPY api/src api/src
RUN npm run build --workspace @chitthi/api

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY api/package.json api/
COPY web/package.json web/
# The lockfile can't tell npm which libc this is, so it installs sharp for glibc and wasm32 as well
# as for musl. Drop the two that can't run here (about 25 MB), then prove sharp still loads.
RUN npm ci --workspace @chitthi/api --omit=dev --ignore-scripts \
 && rm -rf node_modules/@img/sharp-linux-x64 node_modules/@img/sharp-libvips-linux-x64 \
      node_modules/@img/sharp-wasm32 node_modules/@emnapi \
 && node -e "import('sharp').then((m) => console.log('sharp', m.default.versions.sharp, 'libvips', m.default.versions.vips))"

FROM ${NODE_IMAGE} AS api
# npm and corepack are not needed at run time; removing them leaves less to patch and to abuse.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
# Code and dependencies belong to root and are read-only to the "node" user (uid 1000) the API runs as.
COPY package.json ./
COPY api/package.json api/
COPY --from=deps /src/node_modules node_modules
COPY --from=build /src/api/dist api/dist
USER node
EXPOSE 8082
# busybox wget: no extra package, and no second node process every 30 s.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8082/api/health || exit 1
CMD ["node", "api/dist/server.js"]

# One-off job before each deploy: migrations as the owner (MIGRATION_DATABASE_URL), then the
# chitthi_api login password from DATABASE_URL. Same layers as the API plus dbmate and the SQL.
FROM api AS migrate
COPY --from=build /src/node_modules/@dbmate/linux-x64/bin/dbmate /usr/local/bin/dbmate
COPY db/migrations db/migrations
COPY scripts/set-api-db-password.mjs scripts/
HEALTHCHECK NONE
CMD ["sh", "-c", "dbmate --env MIGRATION_DATABASE_URL --no-dump-schema --wait --wait-timeout 60s up && exec node scripts/set-api-db-password.mjs"]
