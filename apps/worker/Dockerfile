# syntax=docker/dockerfile:1
# MediaVault worker. Same workspace as the API plus ffmpeg/ffprobe for posters
# and HLS transcoding.
FROM oven/bun:1-debian AS deps
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/media/package.json packages/media/package.json

RUN bun install --frozen-lockfile --production

FROM oven/bun:1-debian AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/data \
    CACHE_DIR=/cache \
    MEDIA_ROOT=/media \
    WORKER_POLL_MS=500

# Bun's isolated linker keeps dependency symlinks inside each workspace, so the
# installed trees are copied before the sources are overlaid on top.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/worker ./apps/worker

COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN mkdir -p /data /cache

CMD ["bun", "run", "apps/worker/src/index.ts"]
