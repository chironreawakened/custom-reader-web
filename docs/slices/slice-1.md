# Slice 1 — report (2026-10-30)

Slice 1 scope from PLAN.md: **Login** — email-code authentication
(6-digit code via Gmail SMTP behind a `Mailer` interface), session
handling (web cookie + bearer), `GET /v1/me`, logout, CSRF + rate
limits, break-glass CLI, web login UI, e2e in CI.

Scope note: the handoff message mentioned "first encrypted
upload/download" in slice 1; per PLAN.md that is slice 2. Login only was
built.

## What was built

- **Migration 0001** (`0001_far_warlock.sql`, drizzle-generated):
  `app.login_codes` + `app.sessions`. Also fixed a latent schema
  qualification bug: `schema.ts` now uses `pgSchema("app").table(...)`
  (the old `pgTable("app.users", …)` form would have targeted the public
  schema); baseline drizzle snapshot seeded so future diffs are clean.
- **Idempotent migration runner** (`src/db/migrate.ts`): tracks applied
  files in `app.migrations`; one-time transition guard seeds the ledger
  with `0000.sql` on the pre-existing prod DB (fresh DBs run 0000
  normally). Re-deploys skip applied files.
- **OTP service** (`services/otp.ts`): 6-digit code, 10-min expiry,
  HMAC-SHA256 stored (subkey = HKDF-SHA256(master key, `otp-hmac/v1`),
  code never stored), max 5 attempts, single-use, new code invalidates
  old ones.
- **Session service** (`services/session.ts`): 256-bit random token,
  SHA-256 hash stored, web (30 d cookie) and bearer (90 d) kinds,
  sliding expiry with 12 h threshold and 90/180 d absolute caps,
  revoke by token/id. Clock-injectable for tests.
- **Rate limits** (`services/rate-limit.ts`): in-memory sliding window —
  request-code 5/15 min per IP and 5/h per email; verify 20/15 min per
  IP. Uniform responses so limits reveal nothing about the address.
- **Mailer** (`services/mailer.ts`): `Mailer` interface, `SmtpMailer`
  (nodemailer/Gmail), `ConsoleMailer` (CI/e2e — appends the code to a
  mailbox file), `createMailer` factory driven by `MAILER=smtp|console`.
- **Auth routes** (`routes/auth.ts` + `server.ts`):
  - `POST /v1/auth/request-code` — find-or-create (only `ALLOWED_EMAIL`
    creates a user, so probing with random addresses never floods
    `app.users`), issues code, emails it; always `202 {sent:true}`.
  - `POST /v1/auth/verify-code` — generic `401 invalid_code` for all
    failure modes; web client → `HttpOnly; SameSite=Lax` (+Secure in
    prod) session cookie, `204`; bearer client → `{token}`, `200`.
  - `POST /v1/auth/logout` — revokes, clears cookie, `204`.
  - `GET /v1/me` — cookie or `Bearer`; `401 unauthorized` when out.
  - CSRF: cookie-authenticated mutating calls require
    `X-Requested-With: reader` + `Origin` matching `RDR_HOSTNAME`
    (http in ci, https in prod); bearer exempt.
- **Break-glass CLI**: `docker compose exec api node dist/cli.js
  login-code` — issues a valid code for `ALLOWED_EMAIL`, emails it, and
  prints it to the API logs (for when SMTP is down).
- **Config** (`config.ts`): `MAILER`, `SMTP_HOST/PORT/USER/PASS`
  (required only for smtp), `RDR_ENV=prod|ci`; `.env.example` updated.
- **Web login UI** (`apps/web/src/`): email form → 6-digit code inputs →
  signed-in view (`/v1/me`) → logout, TanStack Query; thin fetch client
  in `apps/web/src/api.ts`.
- **e2e** (`e2e/`): Playwright specs (full login loop + wrong-code
  rejection) against the real SPA; `docker-compose.e2e.yml`
  (postgres + adobe/s3mock as the S3 stand-in); new CI `e2e` job (CI
  only — never on the VPS); CI now also builds + pushes the
  `custom-reader-web` image; `deploy.sh` extracts the static web build
  into `/srv/reader/web-dist` for Caddy.
- **S3 client**: `ensureBucket()` (HeadBucket/CreateBucket) so a fresh
  S3 stand-in works; no-op in prod where the Hippius bucket exists.

**New dependencies:** `@fastify/cookie` (api), `@playwright/test`
(e2e dev-only), nodemailer already present from slice 0.

## Verified (real output, 2026-10-30, local verify stack)

Local stack: postgres:17 + adobe/s3mock (MinIO stand-in) + the
locally built API with `MAILER=console` (scratch files, gitignored).

- `pnpm -r lint` / `typecheck` / `test`: green — 45 shared + 15 api
  unit tests passing.
- Fresh DB: migrations 0000 + 0001 apply cleanly; health →
  `{"api":"ok","db":"ok","storage":"ok (encrypted)"}`.
- Full curl loop, all expected:
  1. request-code → `202`, 6-digit code in console mailbox
  2. verify wrong code → `401 invalid_code`
  3. verify correct code → `204` + session cookie (~13 ms)
  4. `/v1/me` with cookie → `200 {email, createdAt}`
  5. code reuse → `401` (single-use)
  6. `/v1/me` unauthenticated → `401 unauthorized`
  7. logout → `204`
  8. `/v1/me` after logout → `401`
  9. bearer client: verify → `200 {token}`; `/v1/me` with
     `Authorization: Bearer` → `200`
- Break-glass CLI: `node dist/cli.js login-code` → code emailed (console
  mailbox) + printed.

### Bug found & fixed during verification
`await reply.setCookie(...)` deadlocked the verify-code handler:
Fastify's `Reply` is *thenable* and `reply.then()` resolves on **socket
end** — so awaiting the (synchronous, reply-returning) `setCookie`
waited for a socket that could only close after the response was sent.
Fixed by not awaiting (`setCookie`/`clearCookie` are sync; same latent
bug fixed in logout). Commented in code.

## How the owner verifies (post-deploy)

1. `curl https://peisetti.duckdns.org/v1/health` → 200 with
   `"api":"ok","db":"ok"`.
2. Open `https://peisetti.duckdns.org/` → "Personal Reader" login page.
3. Enter `vm.tikkanen@gmail.com` → Send code → an email from
   `chironreawakened@gmail.com` arrives with a 6-digit code.
4. Enter the code → "Hello vm.tikkanen@gmail.com" + Log out button.
   Log out returns to the form; the old session stops working.
5. (Optional) wrong code → generic "invalid or expired code".

## Known gaps / follow-ups
- e2e Playwright runs in CI only; it could not be executed on the VPS
  (MinIO image pull is blocked there), so CI is the first place the
  browser flow runs.
- S3 stand-in for e2e is `adobe/s3mock` (same image as the VPS
  local-verify stack): MinIO's older Docker Hub tags get pruned — the
  first CI run pulled a tag that already 404'd, and even real release
  tags from 2024-09 stopped resolving by the second run. s3mock is
  stable, accepts any credentials, and passed the full login loop
  locally before being reused in CI.
- In-memory rate limits reset on API restart (acceptable for a
  single-user, single-container app).
- Session `user_agent` is stored but no per-device view yet (later
  slice per PLAN.md).

## Deviations
- None beyond those already approved in slice 0. The handoff's
  "upload/download in slice 1" wording was resolved in favour of
  PLAN.md (slice 1 = Login); flagged here per AGENTS.md.

## Post-deploy infrastructure fix (2026-10-30, prod)
- Caddy static 404s after first deploy: the Mattermost Caddy container
  had no bind mount for `/srv/reader/web-dist`, so the `file_server`
  root didn't exist inside the container (slice 0 only ever checked
  `/v1/health`, which goes through the reverse proxy). Fixed by adding
  `/srv/reader/web-dist:/srv/reader/web-dist:ro` to the caddy service
  in `/opt/mattermost/docker-compose.yml` (backup
  `docker-compose.yml.bak-20261030`) and recreating caddy.
- `deploy.sh` hardened against the same class of failure: web-dist
  contents are now swapped **in place** (never `rm -rf` + `mv` the dir —
  that would orphan Caddy's bind mount to a deleted inode), and the
  health check additionally asserts the extraction produced
  `index.html` + `assets/`, plus a final public check of `/` and
  `/v1/health` through Caddy.
