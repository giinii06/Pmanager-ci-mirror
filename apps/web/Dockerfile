# syntax=docker/dockerfile:1
# MediaVault web. Vite builds a static bundle that the container serves with
# nginx; the edge proxy in compose.yaml forwards /api to the API service.
FROM oven/bun:1-debian AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/media/package.json packages/media/package.json

RUN bun install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

RUN bun run --cwd apps/web build

FROM nginx:alpine AS runtime
COPY deploy/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
