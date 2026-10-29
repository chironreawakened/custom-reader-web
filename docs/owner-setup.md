# Owner setup — VPS (single prod environment)

One environment in `/srv/reader`, secrets in `/home/ubuntu/reader/.env`
(mode 600, never committed). Caddy runs on the host (Mattermost's);
Docker via `sudo` (`ubuntu` is not in the docker group).

Work through this in order. Everything here has already been prepared
where possible; the remaining steps need the owner's input.

## 1. VPS prerequisites (already done unless noted)

- Docker installed. ✔ (confirm: `sudo docker version`)
- 4 GB swap file. ✔ (created 2026-10-29)
- Node 24 available for local validation. ✔ (`~/.local/node24/bin/node`)
- **DuckDNS**: pick a free subdomain, e.g. `reader.duckdns.org`, and
  point it at the VPS IP **54.37.233.34**. (Q1b — not done yet.)
- Ports 80/443 open (needed for Let's Encrypt HTTP-01).
- **Hippius**: top up the account (currently `InsufficientAccountCredit`).
  The bucket `custom-reader` and keys are already in `.env` (Q1).
- **Gmail**: app password for the mailer, and the owner's
  `ALLOWED_EMAIL`. (Currently placeholders in `.env`.)

## 2. Secrets — `/home/ubuntu/reader/.env` (mode 600)

Create it once:

```sh
mkdir -p /home/ubuntu/reader
touch /home/ubuntu/reader/.env
chmod 600 /home/ubuntu/reader/.env
```

Fill in (template in the repo's `.env.example`):

```sh
APP_MASTER_KEY=*** rand -base64 32)   # THE key for all content — back it up!
HIPPUS_ENDPOINT=https://eu-central-1.hippius.com
HIPPUS_REGION=decentralized
HIPPUS_BUCKET=custom-reader
HIPPUS_ACCESS_KEY=***        # already filled by the owner
HIPPUS_SECRET_KEY=***             # already filled by the owner
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=<you@gmail.com>
SMTP_PASS=<Gmail app password>
ALLOWED_EMAIL=<you@gmail.com>
RDR_HOSTNAME=<your-name>.duckdns.org
POSTGRES_PASSWORD=*** rand -base64 24)
```

⚠️ **`APP_MASTER_KEY`**: losing it = losing all content. Store a copy
outside the VPS (e.g. a password manager). Do not echo it in chat.

## 3. Code on the VPS

```sh
sudo mkdir -p /srv/reader
sudo chown ubuntu /srv/reader
git clone git@github.com:chironreawakened/custom-reader-web.git /srv/reader
cd /srv/reader
git checkout slice-0
```

Replace the hostname placeholder in `Caddyfile.reader` with the chosen
DuckDNS name, and append that block to Mattermost's Caddy config, then
`sudo systemctl reload caddy` (or the Mattermost Caddy equivalent).

## 4. First deploy

1. Wait for a **green CI run** on GitHub (it builds the api image and
   pushes `ghcr.io/chironreawakened/custom-reader-api:<sha>`).
2. Deploy that sha:

```sh
sudo /srv/reader/deploy.sh <commit-sha>
```

This pulls the image, runs the migration in a one-off container, starts
postgres + api + worker, and polls `/v1/health`. On failure it prints a
rollback hint (`sudo /srv/reader/deploy.sh <previous-tag>`).

3. **Static web** (known gap, slice 0): the Caddyfile serves
   `/srv/reader/web-dist`. Until a web image exists:

```sh
pnpm install --frozen-lockfile && pnpm --filter @reader/web build
sudo mkdir -p /srv/reader/web-dist
sudo cp -r apps/web/dist/. /srv/reader/web-dist/
```

## 5. Verify

- `curl -fsS https://<name>.duckdns.org/v1/health` → 200 with
  `api ok`, `db ok`, `storage ok (encrypted)`, and
  `details.ranged_get: "supported"` (confirms Hippius ranged GETs).
- Browser on the same URL shows the same three statuses.
- Hippius console: no leftover objects after a health check; any object
  uploaded by the app is unreadable ciphertext.

## 6. Operations

- **Break-glass login** (slice 1+):
  `sudo docker compose -f /srv/reader/docker-compose.yml exec api node dist/...` —
  the `login-code` CLI lands with slice 1.
- **Logs**: `sudo docker compose -f /srv/reader/docker-compose.yml logs -f api worker`.
- **Backups**: Postgres + the bucket. A daily/weekly `backups` table and
  encrypted backup objects come in a later slice; until then take plain
  `pg_dump` + note that the `APP_MASTER_KEY` backup is the critical one.
