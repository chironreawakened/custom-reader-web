#!/usr/bin/env bash
# Deploy a built image tag to the reader stack. Run as root or via sudo.
#   sudo /srv/reader/deploy.sh <sha-or-tag>
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

echo ">> health check"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3100/v1/health >/dev/null 2>&1; then
    echo "healthy"; exit 0
  fi
  sleep 2
done
echo ">> health check FAILED - rolling back" >&2
echo "Roll back: sudo /srv/reader/deploy.sh <previous-tag>" >&2
exit 1
