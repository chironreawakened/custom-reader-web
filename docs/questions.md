# Questions for the owner

## Q1 (2026-10-29, slice 0): Dev Hippius credentials and DuckDNS name are missing

**RESOLVED 2026-10-29 (owner decision: single prod environment, no dev/prod
split).** Prod `.env` at `/home/ubuntu/reader/.env` (mode 600, outside the
repo). Owner filled in Hippius creds for bucket `custom-reader`.
Credentials verified working against Hippius (list_buckets/head_bucket OK).
Open items:

- Hippius account has **no credit** — PutObject fails with
  `InsufficientAccountCredit`. Owner must top up the account before the
  storage round-trip can be verified.
- DuckDNS hostname still not chosen (needed in the Caddyfile and
  `docs/owner-setup.md`; owner will pick a name later — see Q1b).
- `ALLOWED_EMAIL` and Gmail app password still placeholders in the `.env`.

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

## Q1b (2026-10-29): DuckDNS hostname

Awaiting the owner's name choice (any free subdomain of `duckdns.org`,
pointed at VPS IP 54.37.233.34). Until then the Caddyfile uses the
placeholder `RDR_HOSTNAME` from the `.env`.

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
