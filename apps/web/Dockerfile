FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @reader/web build

FROM alpine:3.20
COPY --from=build /app/apps/web/dist /srv/reader/web-dist
CMD ["sh", "-c", "echo static build at /srv/reader/web-dist"]
