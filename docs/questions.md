# Questions for the owner

## Q1 (2026-10-29, slice 0): Dev Hippius credentials and DuckDNS name are missing

**RESOLVED 2026-10-29 (owner decision: single prod environment, no dev/prod
split).** Prod `.env` at `/home/ubuntu/reader/.env` (mode 600, outside the
repo). Owner filled in Hippius creds for bucket `custom-reader`.
Credentials verified working against Hippius (list_buckets/head_bucket OK).

**RESOLVED 2026-10-29 (later): all three open items closed.**

- Hippius account funded by owner; verified with a real round-trip:
  PUT → full GET → ranged GET (2 exact ranges) → DELETE, all OK
  (`HIPPUS_STORAGE: ALL_OK`). App health check reports
  `storage: "ok (encrypted)"`.
- DuckDNS hostname: `peisetti.duckdns.org` (owner-claimed 2026-10-29,
  pointed at 54.37.233.34 from the DuckDNS settings UI; A record verified
  with dig). Wired into the Mattermost Caddy at `/opt/mattermost/Caddyfile`
  with auto Let's Encrypt (HTTP-01) — cert issued, and
  `https://peisetti.duckdns.org/v1/health` returns 200 from the public
  internet. See Q1b.
- SMTP (`SMTP_HOST/PORT/USER/PASS`) now set in the `.env` from the
  existing `/etc/mail-gmail/mail.env` (owner: "use your own gmail account
  for emailing"); a real test message was sent successfully 2026-10-29.

PLAN.md lists these as owner setup *before slice 0*, but none exist on the VPS yet:

- No dev `APP_MASTER_KEY` found (nothing in `~` or any env file; no `/home/hermes/reader`).
- No Hippius access key / secret key / dev bucket available anywhere on this machine
  (no `~/.aws`, no env vars, no issues on the repo with them).
- No DuckDNS hostname chosen/pointed at the VPS (needed in the Caddyfile and
  `docs/owner-setup.md`).

Asked the owner directly (Mattermost) for:

1. Hippius **dev** bucket name + access key + secret key. (Owner
   answered 2026-10-29: dev `.env` created at `/home/ubuntu/reader/.env`
   (mode 600) with placeholders for them to fill in; endpoint
   `https://eu-central-1.hippius.com` + region `decentralized` confirmed
   from docs.hippius.com; dev `APP_MASTER_KEY` generated locally in that
   file.)
2. The DuckDNS hostname (e.g. `reader.example.duckdns.org`) so the Caddyfile,
   owner docs and verification steps use the real name.
3. Confirmation to use a locally generated dev `APP_MASTER_KEY` (32 random
   bytes, base64) that I generate on the VPS for dev only.

## Q1b (2026-10-29): DuckDNS hostname — RESOLVED

`peisetti.duckdns.org`, claimed by the owner on the DuckDNS site (GitHub
login; account page is reCAPTCHA-gated for this VPS's datacenter browser).
Owner pointed it at 54.37.233.34 from the DuckDNS settings; A record
verified 2026-10-29 with `dig` (54.37.233.34).

Wired in 2026-10-29:

- `/home/ubuntu/reader/.env`: `RDR_HOSTNAME=peisetti.duckdns.org`.
- Site block appended to `/opt/mattermost/Caddyfile` (backup:
  `/opt/mattermost/Caddyfile.bak-20261029`), mirrored in the repo as
  `Caddyfile.reader`. Let's Encrypt cert auto-issued (HTTP-01) and valid.
- **Networking gotchas found + fixed** (both now in `Caddyfile.reader`):
  1. Caddy runs in Docker on the `mattermost_default` bridge, so the API on
     the host is reached as `172.18.0.1:3100` (host gateway IP), **not**
     `127.0.0.1:3100`.
  2. UFW default-deny dropped container→host traffic; added
     `sudo ufw allow from 172.18.0.0/16 to any port 3100 proto tcp`.
- Verified end-to-end: `curl https://peisetti.duckdns.org/v1/health` from
  the public internet → HTTP 200 with
  `{"api":"ok","db":"ok","storage":"ok (encrypted)"}` (temporary test API +
  test Postgres since the real stack is not deployed via compose yet).

Note for the future: DuckDNS account token still unknown to us — with the
static IP that's fine (no updater needed). If the VPS IP ever changes,
ask the owner for the token from the DuckDNS account page.

## Q4 (2026-10-29, resolved same day): Single prod environment

Owner decision: develop **in the prod environment** (one env, no dev
stack). Consequences applied to PLAN.md:

- One Hippius bucket (`custom-reader`), one `APP_MASTER_KEY` (already in
  the `.env` — owner must back it up).
- Hermes runs as `ubuntu` **with sudo** and may run `deploy.sh`. AGENTS.md
  updated to match (owner approved 2026-10-29).
- `ubuntu` has no docker group access; all Docker commands go via sudo.

## Q2 (2026-10-29, slice 0): Dev environment deviates from PLAN.md (SUPERSEDED by Q4)

Superseded: there is no dev environment anymore. Remaining facts that
still hold: `ubuntu` is not in the `docker` group (all Docker via
sudo). Swap now exists (4 GB file, created 2026-10-29).

## Q3 (2026-10-29, slice 0): Node version

Node on the VPS is 26.8.2; PLAN pins Node 24 LTS. I will pin Node 24
(`engines`/`.nvmrc`/Dockerfile/CI) and run local validation on a local Node 24
install. Confirm that's acceptable (vs. updating the pin to Node 26, which I
won't do unilaterally since the plan fixes it).
