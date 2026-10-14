# syntax=docker/dockerfile:1.7
#
# Katale AI production images — one multi-stage Dockerfile, three runtime targets:
#   docker buildx build -f docker/Dockerfile --target api      -t <ns>/katale-api:<tag> .
#   docker buildx build -f docker/Dockerfile --target web      -t <ns>/katale-web:<tag> .
#   docker buildx build -f docker/Dockerfile --target whatsapp -t <ns>/katale-whatsapp:<tag> .
# (scripts/release-images.sh builds and pushes all three.)
#
# All targets share one cached build stage. Runtime images contain only compiled output and
# production dependencies, run as the non-root `node` user, and contain no secrets.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# build: install the workspace, generate Prisma, compile all apps, prune prod deps
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    # Chromium comes from Debian in the whatsapp image; never download Puppeteer's browser.
    PUPPETEER_SKIP_DOWNLOAD=true
RUN corepack enable
WORKDIR /repo

# Dependency layer: lockfile + root manifest (its packageManager field pins pnpm via Corepack),
# so source edits don't invalidate the package cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Version-pinned dependency patches (e.g. whatsapp-web.js media download fix).
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
# postinstall runs `prisma generate` (needs only the schema, no database).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile

RUN pnpm --filter @vca/api build \
 && pnpm --filter @vca/whatsapp build \
 && pnpm --filter @vca/web build

# Production-only node_modules per runtime (workspace packages are bundled into dist).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @vca/api deploy --prod /out/api \
 && pnpm --filter @vca/whatsapp deploy --prod /out/whatsapp

# ---------------------------------------------------------------------------
# api: Fastify API + migration/seed tooling
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# `katale-migrate`: `prisma migrate deploy` using the deployed @vca/database package, which already
# carries the schema, committed migrations, prisma.config.ts and (as a sibling dependency) the CLI.
RUN printf '#!/bin/sh\nset -e\ncd "$(readlink -f /app/node_modules/@vca/database)"\nexec node ../../prisma/build/index.js migrate deploy\n' > /usr/local/bin/katale-migrate \
 && chmod 755 /usr/local/bin/katale-migrate
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# web: Next.js standalone server
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/console').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# whatsapp: whatsapp-web.js worker + Debian Chromium
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS whatsapp
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    WHATSAPP_CHROME_PATH=/usr/bin/chromium \
    WHATSAPP_HEADLESS=true \
    WHATSAPP_SESSION_DIR=/data/whatsapp \
    WHATSAPP_GATEWAY_HOST=0.0.0.0 \
    WHATSAPP_GATEWAY_PORT=4100
WORKDIR /app
COPY --from=build --chown=node:node /out/whatsapp/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/whatsapp/dist ./dist
# /app must be writable: whatsapp-web.js keeps its web-version cache in ./.wwebjs_cache.
# /data/whatsapp is the LocalAuth session — mount a persistent volume there (never baked in).
RUN mkdir -p /data/whatsapp && chown -R node:node /app /data
USER node
VOLUME ["/data/whatsapp"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
