#!/usr/bin/env bash
# Deploy a built image tag to the reader stack. Run as root or via sudo.
#   sudo /srv/reader/deploy.sh <sha-or-tag>
#
# Pulls the api/worker images, runs migrations, restarts the stack, extracts
# the static web build from the web image into /srv/reader/web-dist (served
# by Caddy) and health-checks the API.
set -euo pipefail
cd /srv/reader

TAG="${1:?usage: deploy.sh <sha-or-tag>}"
export TAG
export POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' /home/ubuntu/reader/.env | cut -d= -f2-)"

echo ">> pulling ghcr.io/...api:${TAG}"
docker compose pull api worker

echo ">> running migrations (one-off api container)"
docker compose run --rm api node dist/db/migrate.js

echo ">> up -d"
docker compose up -d

echo ">> updating static web build"
docker pull "ghcr.io/chironreawakened/custom-reader-web:${TAG}"
docker rm -f reader-web-extract 2>/dev/null || true
docker create --name reader-web-extract "ghcr.io/chironreawakened/custom-reader-web:${TAG}" true
# Replace contents IN PLACE. Never `rm -rf` + `mv` the dir itself: Caddy has
# a bind mount on /srv/reader/web-dist, and swapping the directory inode
# leaves the mount pointing at a deleted inode (static 404s) until Caddy is
# recreated. In-place content swap keeps the inode stable.
mkdir -p /srv/reader/web-dist
find /srv/reader/web-dist -mindepth 1 -delete
docker cp reader-web-extract:/srv/reader/web-dist/. /srv/reader/web-dist/
chmod -R a+rX /srv/reader/web-dist
docker rm -f reader-web-extract

echo ">> health check"
test -s /srv/reader/web-dist/index.html && test -n "$(ls -A /srv/reader/web-dist/assets 2>/dev/null)" \
  || { echo ">> web-dist is incomplete — deploy failed before health check" >&2; exit 1; }
for i in $(seq 1 30); do
  if curl -fsS http://172.18.0.1:3100/v1/health >/dev/null 2>&1; then
    echo "healthy"; break
  fi
  sleep 2
done
# Final public check (Caddy -> API + static): both must answer 200.
for i in $(seq 1 15); do
  if curl -fsS -o /dev/null https://peisetti.duckdns.org/v1/health \
     && curl -fsS -o /dev/null -w '' https://peisetti.duckdns.org/; then
    echo "public OK (api + static)"; exit 0
  fi
  sleep 2
done
echo ">> health check FAILED - rolling back" >&2
echo "Roll back: sudo /srv/reader/deploy.sh <previous-tag>" >&2
exit 1
