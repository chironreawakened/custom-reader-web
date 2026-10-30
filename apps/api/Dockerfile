# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @reader/api build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# esbuild marks runtime deps as external, so they must resolve from
# apps/api's node_modules (pnpm workspace layout). Copy the whole build
# tree to keep the symlink structure intact.
COPY --from=build /app ./
USER node
WORKDIR /app/apps/api
CMD ["node", "dist/server.js"]
