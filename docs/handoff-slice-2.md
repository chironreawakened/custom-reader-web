# Handoff — end of Slice 2 (EPUB), start of Slice 3

**Date:** 2026-10-31 · **Repo:** `/home/ubuntu/projects/custom-reader-web` (branch `main`) · **Owner:** vee
**Status:** Slice 2 COMPLETE, CI green, deployed to production, verified live (real upload → `ready` → sections + signed assets through the public URL). Next: **Slice 3 (TOC, progress, reader basics)**.

---

## 1. Where things stand

- **HEAD:** `13987da` (tree clean, `main` pushed). Tags: `slice-0`, `slice-1`, `slice-2` (→ `13987da`).
- **CI: GREEN** on the final commit (jobs: `test` [lint+typecheck+96 unit tests], `e2e` [Playwright vs postgres + `adobe/s3mock`, **serial, worker started in CI**], `images` [GHCR build+push]).
- **Prod is live on `slice-2`** — verified by Hermes end-to-end through `https://peisetti.duckdns.org`: health ok, login (break-glass code), fixture EPUB upload → 201 → `ready` (title "Night Fixture Book", 3 sections, cover, wordCount 43), sections list + section HTML (decrypted, image rewritten to signed asset URL, prev/next populated).
- `docs/slices/slice-2.md` exists (required by AGENTS.md).
- Caddy `request_body { max_size 209715200 }` now **live** on the `peisetti.duckdns.org` `/v1/*` handle (repo `Caddyfile.reader` is the source; applied + `caddy reload`ed).

### Commits (slice 2, see `git log --oneline -6`)
1. `3900ade` feat: the whole slice (streaming RDR1 upload, parser, pg-boss, documents API, web reader UI, backup job, 18 unit tests + e2e spec, CI worker, Caddy cap).
2. `70cf1fa` fix(e2e): serial execution + per-login mailbox baseline (single-use codes).
3. `13987da` docs: slice 2 report.

## 2. Production layout (what exists on the VPS)

- **Domain:** `https://peisetti.duckdns.org` → Caddy (Mattermost Docker stack, `/opt/mattermost/Caddyfile`):
  - `handle /v1/*` → `request_body max_size 209715200` + `reverse_proxy 172.18.0.1:3100`
  - `handle` → `root * /srv/reader/web-dist` + `try_files` SPA fallback + `file_server`
  - Caddyfile backup: `/opt/mattermost/Caddyfile.bak-20261031-slice2`.
- **Reader stack:** `/srv/reader/docker-compose.yml` — `postgres` (pg17), `api` + `worker` (same GHCR api image; worker = `node dist/worker.js`, now does real work: `epub.process` + `backup.nightly`), `TAG` in `/srv/reader/.env` = `13987dae1746c3fe2ef099a4fe1a89a89ee2eaac` (backup `.env.bak-20261031-slice2`).
- **Secrets:** `/home/ubuntu/reader/.env` (mode 600, `env_file` for api+worker): `APP_MASTER_KEY`, Hippius, `ALLOWED_EMAIL=vm.tikkanen@gmail.com`, `MAILER=smtp` (Gmail app password), `RDR_HOSTNAME=peisetti.duckdns.org`, `RDR_ENV=prod`.
- **DB access:** `cd /srv/reader && sudo docker compose exec -T postgres psql -U reader -d reader -c "…"`. App data in schema `app`: `documents`, `document_sections`, `toc_entries`, `assets`, `backups`, `storage_objects`, `login_codes`, `sessions`, `users` (+ system user `system@reader.local` for backup rows).
- **Deploy:** `sudo /srv/reader/deploy.sh <sha>` (in-place web-dist swap, public `/` + `/v1/health` gate). Repo copy is source of truth.
- **Break-glass code:** `cd /srv/reader && sudo docker compose exec api node dist/cli.js login-code` (prints `[cli] break-glass code for …: NNNNNN`).
- **Worker jobs:** `epub.process` (batch 2, 2 retries, 1 h expiry) + `backup.nightly` (`0 3 * * *` Europe/Helsinki, `pg_dump --schema=app --format=plain` → RDR1 → Hippius; retention 14 daily + 8 weekly). Tables in `pgboss` schema.

## 3. Gotchas (new in slice 2 — the full list is in the skill `custom-reader-web`)

1. **S3 `PutObject` rejects lengthless Node readable streams** (`ERR_HTTP_INVALID_HEADER_VALUE`) — the ciphertext is buffered to a temp file and re-read with a known length (`object-store.ts` `putCiphertextStream`). Only surfaces at runtime; always re-run a real upload against s3mock after storage changes.
2. **Every process holding a pg-boss client must `await boss.start()`** — the API *and* the worker. Missing it on the API = upload 201s, job never exists, doc stuck `pending`, zero rows in `pgboss.<queue>`.
3. **e2e must run serially** (`workers: 1`) — all specs share one `ALLOWED_EMAIL` and codes are single-use; also each login reads only mailbox lines after its own request.
4. **`verify-code` body = `{email, code, client}`**; cookie mutating calls need `X-Requested-With: reader` + matching `Origin`.
5. **`new Uint8Array(atob(s))` allocates zeros** (string = length) — never use for base64 fixtures; `Uint8Array.from(Buffer.from(s, "base64"))`, and generate images with a real encoder.
6. **Drizzle two-way circular FKs break tsc** — `documents.cover_asset_id → assets.id` is one-way in code, reverse FK hand-written in `0003` SQL. Never "fix" it by adding the reverse `.references()`.
7. **pg-boss v10 queue options** (`expireInSeconds`/`retryLimit`/`retentionSeconds`) go on `boss.createQueue(name, {...})` BEFORE `work()`; `work()` only takes `{batchSize, pollingIntervalSeconds}`.
8. **Fastify reply is thenable** — never `await reply.setCookie/clearCookie`.
9. **VPS:** 4 GB RAM, no image builds / no Playwright locally (CI only), Docker Hub WAF-blocked, all docker via sudo. Unattended runs: keep shell commands simple (no pipe-heavy one-liners — they trip the security-approval gate and hang until a human consents).

## 4. Local verification stack (still available)

- `e2e/.local-verify.env` + `e2e/docker-compose.local-verify.yml` (gitignored): API on `127.0.0.1:3101`, postgres `54329` (`e2e-postgres-1`), s3mock `9000`, console mailer → `/tmp/local-mailbox.log`.
- Start: `set -a && source e2e/.local-verify.env && set +a` then `cd apps/api && pnpm build && LOG_LEVEL=warn node dist/server.js` **and** `node dist/worker.js` (both needed — the worker processes uploads; as of 2026-10-31 both were left running as background hermes processes — check `ss -tlnp | grep 3101` before starting again).
- **Prod-vs-local trap:** `ps` also shows the PROD docker `node dist/server.js`/`worker.js` (cwd `/app/apps/api`, ppid = containerd-shim, :3100). Only kill local PIDs explicitly; killing prod is a real incident.
- Local test DB has 3 `ready` fixture docs + 1 stuck `pending` (`cc7ad6ea-…`, pre-`boss.start()` bug) — safe to wipe: `sudo docker exec e2e-postgres-1 psql -U reader -d reader -c "truncate app.documents, app.document_sections, app.toc_entries, app.assets, app.storage_objects restart identity"` (and `rm -f /tmp/local-mailbox.log` cookie jars) for a clean run.
- Fixture generator: `node apps/api/tools/make-fixture-epub.mjs /tmp/x.epub` (3 sections, cover PNG, TOC via nav map).

## 5. Slice 3 — what's next (per PLAN.md §"Slice 3: TOC, progress, reader basics")

Scope: **TOC menu (with fallbacks), themes and font size, progress sync, covers, DRM detection, language detection.**
**Verify (owner):** close the tab, reopen on another device, land on the same spot.

Already done in slice 2 that slice 3 builds on:
- TOC API (`/v1/documents/:id/toc`) + nav-map/NCX/spine fallbacks in the parser, cover asset + `coverUrl` in doc meta, signed-URL image serving, `toc_entries`/`assets` tables, `system@reader.local` user row.
- **DRM detection exists** (`services/epub/detect-drm.ts`: `adobe-drm`/`.drm` paths, ADEPT/open-drm OPF meta, `<key-system>`; `parseEpub` returns `drm` — worker must/does reject with a clear `ingestError`). Test it with a DRM-marked fixture before calling it done.
- Language is mapped to `english|finnish|simple` on ingest (`parse-epub.ts`).
- Schema already has commented placeholders for `highlights`, `reading_progress`, `user_settings` (schema.ts ~line 164) — slice 3 adds `reading_progress` + `user_settings` migrations; slice 4 does highlights.

Likely shape:
1. Migration(s): `reading_progress` (user+document → last section id, position, updated_at) + `user_settings` (theme, font size).
2. API: `GET/PUT /v1/documents/:id/progress`, `GET/PUT /v1/me/settings` (CSRF on cookie PUTs).
3. Web: reader remembers position (autosave on section change + optional in-section offset), theme/font-size controls persisted server-side (that's what makes "another device" work), TOC menu UI.
4. Tests: unit for progress/settings + parser DRM/language cases; e2e: open book → navigate → reload → back at the same spot.
5. Re-read SPECS.md relevant sections first (AGENTS.md is binding on this).

## 6. Suggested first moves

1. `git log --oneline -6` + re-read `AGENTS.md`, `PLAN.md` (Slice 3), `SPECS.md` (progress/settings/signed-URL sections).
2. Confirm CI on `main` still green (`~/.local/bin/gh run list --limit 1`) — and check **tonight's 03:00 EET backup ran** on prod: `cd /srv/reader && sudo docker compose exec -T postgres psql -U reader -d reader -c "select id, kind, created_at from app.backups order by created_at desc limit 3"`. **Known bug to verify/fix:** `worker.ts` picks weekly-vs-daily via `getUTCDay()` but the cron is Helsinki-tz (Monday 03:00 EET = Sunday UTC) → `kind` is always `daily`. Fix in the worker (derive weekday in `Europe/Helsinki`) — small, do it before or with slice 3.
3. Start the local verify stack (section 4), upload the fixture, confirm `ready` — that's the regression gate before touching anything.
4. Every slice ends with: `docs/slices/slice-N.md` + tag `slice-N` + deploy + live verify + owner check.

## 7. Open / known gaps

- **Weekly-backup bug** (see §6.2) — the only known functional defect in shipped code.
- No delete-document route (storage rows would orphan) — later slice.
- Backup restore drill — slice 10 per PLAN.md.
- Section HTML sanitizer is a denylist (script/style/onclick/…) not an allowlist — fine for single-user, re-evaluate if ever multi-tenant.
- In-memory rate limits reset on restart (single-user app, accepted).
- `documents.ingest_state` stuck-`pending` doc in the *local* test DB (artifact, see §4).
- Local API+worker background processes from the verification run may still be alive on :3101 — check before starting your own.
- The slice-1 handoff referenced `ALLOWED_EMAIL`/SMTP changes in `/home/ubuntu/reader/.env` — still current; Gmail app password lives in both that file and `/etc/mail-gmail/mail.env` (keep in sync).
