# Dockerfile for the OSS version of Open Archiver

ARG BASE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# 0. Base Stage: Define all common dependencies and setup
FROM ${BASE_IMAGE} AS base
WORKDIR /app

RUN apk add --no-cache --upgrade zlib

# Copy manifests and lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/types/package.json ./packages/types/
COPY apps/open-archiver/package.json ./apps/open-archiver/

# Install the pinned package manager at build time; never switch versions at startup.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "pnpm@$(node -p 'require("/app/package.json").packageManager.split("@")[1]')"

# 1. Build Stage: Install all dependencies and build the project
FROM base AS build
RUN apk add --no-cache python3 py3-setuptools make g++
ENV npm_config_nodedir=/usr/local
COPY packages/frontend/svelte.config.js ./packages/frontend/

# Install all dependencies.
ENV PNPM_HOME="/pnpm"
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --shamefully-hoist --frozen-lockfile --prod=false --store-dir=/pnpm/store

# Copy the rest of the source code
COPY . .

# Build the OSS packages.
RUN test ! -e packages/types/tsconfig.tsbuildinfo \
    && test ! -e packages/backend/node_modules/.host-only \
    && test ! -e packages/backend/dist/.host-only \
    && test ! -e packages/frontend/build/.host-only \
    && test ! -e packages/frontend/.svelte-kit/.host-only \
    && test ! -e packages/backend/.env.host-only \
    && test ! -e packages/backend/.npmrc \
    && test ! -e secrets/.host-only \
    && test ! -e data/.host-only \
    && pnpm build:oss \
    && pnpm test:runtime

# Install native addons for the target architecture, never at application startup.
FROM base AS production-dependencies
RUN apk add --no-cache python3 py3-setuptools make g++
ENV NODE_ENV=production \
    npm_config_nodedir=/usr/local
RUN --mount=type=cache,id=pnpm-production,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir=/pnpm/store \
    && pnpm --recursive --include-workspace-root --store-dir=/pnpm/store rebuild sqlite3 \
    && node -e 'require("./packages/backend/node_modules/sqlite3"); require("concurrently")' \
    && test -x node_modules/.bin/concurrently

# 2. Production Stage: Copy complete runtime dependencies and built artifacts
FROM base AS production
ENV NODE_ENV=production \
    STORAGE_LOCAL_ROOT_PATH=/var/data/open-archiver

RUN apk add --no-cache tini \
    && mkdir -p /var/data/open-archiver \
    && chown node:node /var/data/open-archiver

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=production-dependencies /app/packages/frontend/node_modules ./packages/frontend/node_modules
COPY --from=production-dependencies /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=production-dependencies /app/apps/open-archiver/node_modules ./apps/open-archiver/node_modules

# Copy built application from build stage
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/src/database/migrations ./packages/backend/src/database/migrations
COPY --from=build /app/packages/frontend/build ./packages/frontend/build
COPY --from=build /app/packages/types/dist ./packages/types/dist
COPY --from=build /app/apps/open-archiver/dist ./apps/open-archiver/dist
COPY LICENSE ./LICENSE
COPY packages/types/LICENSE ./packages/types/LICENSE

# Copy the entrypoint script and make it executable
COPY --chmod=755 docker/docker-entrypoint.sh /usr/local/bin/

USER node
RUN node -e 'require("./packages/backend/node_modules/sqlite3")' \
    && pnpm exec concurrently --version \
    && test ! -e packages/backend/node_modules/drizzle-kit \
    && test ! -e packages/backend/drizzle.config.ts \
    && test ! -e packages/frontend/node_modules/@sveltejs/kit \
    && test -z "$(find /app/node_modules -type f -name esbuild -print)"

# Expose the port the app runs on
EXPOSE 4000
EXPOSE 3000

# Set the entrypoint
ENTRYPOINT ["/sbin/tini", "-g", "--", "docker-entrypoint.sh"]

# Start the application
CMD ["pnpm", "docker-start:oss"]
