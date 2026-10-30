# Slice 0 — report (2026-10-29 → 2026-10-30)

Slice 0 scope from PLAN.md: monorepo scaffold, RDR1 crypto module with
tests, API/worker/DB foundation, deployable Docker stack, CI, and a live
health endpoint behind HTTPS.

## What was built
- **pnpm monorepo**: `packages/shared` (RDR1 crypto, zod schemas),
  `apps/api` (Fastify + Drizzle + pg-boss + thin S3 client), `apps/web`
  (Vite SPA shell). Node 24 pin via `packageManager`; local VPS Node is 26
  (works; CI and containers use 24).
- **RDR1 module** (`packages/shared/src/rdr1.ts`): AES-256-GCM, 64 KiB
  segments, 16-byte header, per-object DEK wrapped with HKDF subkeys,
  ranged plaintext reads. 40/40 tests incl. frozen vector, tamper,
  truncation, segment reorder, wrong key — all fail closed.
- **API**: `/v1/health` (api + db + encrypted-storage round-trip),
  config via zod, migrations 0000 (`app` schema: users, login_codes),
  SigV4/path-style Hippius client, pg-boss worker entrypoint.
- **Deploy**: `docker-compose.yml` (postgres:17-alpine + api + worker),
  `deploy.sh`, GHCR images built **in CI only** (never on the VPS).
- **CI**: `.github/workflows/ci.yml` — lint/typecheck/test, e2e
  placeholder, build + push `ghcr.io/chironreawakened/custom-reader-api`
  on main. Green on 2026-10-30 after 3 fixes: pnpm action version source,
  missing esbuild devDep, Dockerfile node_modules layout for pnpm
  workspace externals.

## Verified (real output, 2026-10-30)
- Hippius round-trip from the app: PUT → full GET → ranged GET ×2 →
  DELETE, all byte-exact (`ALL_OK`). Health reports
  `"storage":"ok (encrypted)"`.
- SMTP configured (`SMTP_*` in `/home/ubuntu/reader/.env`) and a real
  test email delivered.
- **DuckDNS**: `peisetti.duckdns.org` → 54.37.233.34 (owner pointed it
  from the DuckDNS settings). Site block appended to the Mattermost
  Caddy (`/opt/mattermost/Caddyfile`, backup `.bak-20261029`); Let's
  Encrypt HTTP-01 cert auto-issued.
- **Production stack running via compose** at `/srv/reader`
  (tag = full git sha in `/srv/reader/.env`): `reader-postgres-1`
  healthy, `reader-api-1` + `reader-worker-1` up, `restart:
  unless-stopped`.
- **Public end-to-end**: `curl https://peisetti.duckdns.org/v1/health`
  → HTTP 200 `{"api":"ok","db":"ok","storage":"ok (encrypted)"}`.

## Networking gotchas (documented, now in Caddyfile.reader)
1. Caddy runs in Docker on `mattermost_default` (gateway 172.18.0.1), so
   the upstream is `172.18.0.1:3100`, not `127.0.0.1:3100`.
2. UFW default-deny dropped container→host traffic;
   `sudo ufw allow from 172.18.0.0/16 to any port 3100 proto tcp`
   (bridge-only exposure; nothing internet-facing on 3100).
3. Compose publishes 3100 on `172.18.0.1` only.

## Known gaps / follow-ups
- `ALLOWED_EMAIL` in `/home/ubuntu/reader/.env` is still a placeholder —
  needed for slice 1 login.
- Web app is an SPA shell (placeholder index in `/srv/reader/web-dist`);
  real UI lands in later slices.
- DuckDNS account token unknown to us; irrelevant while the VPS IP is
  static (no updater). If the IP ever changes, the owner provides the
  token from the DuckDNS account page.
- CI e2e is a placeholder (no Playwright tests yet by design; runs in CI
  only).

## Deviations from PLAN.md (owner-approved)
- Single prod environment, no dev stack (owner, 2026-10-29).
- Agent runs as `ubuntu` with sudo and deploys (owner, 2026-10-29).
- Secrets in `/home/ubuntu/reader/.env` outside the repo (owner
  accepted).
- DuckDNS name `peisetti.duckdns.org` (owner-chosen 2026-10-29).
- Compose publishes the API on the bridge gateway IP (not loopback)
  because the Mattermost Caddy reverse-proxy lives in Docker —
  functionally equivalent exposure (UFW-locked to the bridge).
