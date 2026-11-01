# Handoff — end of Slice 3 (TOC / progress / reader basics), start of Slice 4

**Date:** 2026-11-01 · **Repo:** `/home/ubuntu/projects/custom-reader-web` (branch `main`) · **Owner:** vee
**Status:** Slice 3 COMPLETE in code, CI green, tagged `slice-3` → `11c1643`. **NOT yet deployed** — prod still runs `slice-2` (`13987da`). Remaining for this slice: `deploy.sh` → live verify → owner check. Next feature slice: **Slice 4 (Highlights)**.

---

## 1. Where things stand

- **HEAD:** `cd95b50` (docs), tree clean, `main` pushed. Tags: `slice-0`, `slice-1`, `slice-2` (→ `13987da`), `slice-3` (→ `11c1643`).
- **CI: GREEN** on `main`. Definitive e2e run **41217604688** — `test` success (79 shared + 59 api unit tests), `e2e` success (**4 passed**, 16.9 s), `images` success. Follow-up docs-only run 41218408980 also green.
- **Slice 3 delivered:** reading progress (restore + autosave), reader prefs (theme + font size, persisted server-side so "another device" works), nested TOC rendering, DRM-detection tests, backup-schedule job + tests. `docs/slices/slice-3.md` written.
- **Prod is on `slice-2`** (`TAG=13987dae…`). Deploy of `11c1643` has **not** been run — see §6.

### Commits (slice 3, `git log --oneline -5`)
1. `be17ffe` feat(slice 3): reading progress, reader prefs, nested TOC, DRM tests.
2. `d9dd628` fix(e2e): shared mailbox helper — baseline off-by-one broke the 4th login.
3. `11c1643` fix(e2e): progress spec — restore feature made "title page first" stale.
4. `cd95b50` docs: slice 3 report (CI e2e fixes + green final state).

## 2. The two CI e2e bugs (both fixed — do NOT regress)

The first slice-3 push (`be17ffe`) failed CI e2e. Root causes, in order:

1. **Mailbox baseline off-by-one.** The mailer writes each code as one `\n`-terminated line to `E2E_MAILBOX`. `progress.spec` counted its baseline with raw `readFileSync().split("\n").length` (→ includes the phantom trailing `""`) but scanned with `.split("\n").filter(Boolean)`. Baseline was 1 too high, so its own code sat exactly one index below the scan window → 0 iterations → 15 s timeout. Only `progress` hit it (only spec with a non-empty baseline + baseline-based reader). **Fix:** one shared `e2e/mailbox.ts` — count and scan use the *same* filtered list, so the baseline can't overshoot. All three specs (`login`, `documents`, `progress`) import `login`/`requestCode`/`verifyCode`/`EMAIL` from `./mailbox.js`.
2. **Stale "title page first" assertion.** `documents.spec` runs first (alphabetical, serial) as the **same** `ALLOWED_EMAIL`, and its autosave leaves progress at Chapter One. So `progress.spec`'s "fresh open" correctly *restores* Chapter One — the feature working — not the title page. Fixed the assertion to check a section renders, then jump to Chapter One; the restore assertions after the reload remain the real check.

**e2e rate-limit budget:** 4 `request-code` calls per CI run (login 2, documents 1, progress 1) against the 5/15-min-per-IP limiter. A 5th login spec gets a silent `202` (no mail) → login times out. Keep it at 4.

## 3. Production layout (unchanged from slice 2 — see handoff-slice-2.md §2)

- **Domain:** `https://peisetti.duckdns.org` → Caddy (`/opt/mattermost/Caddyfile`): `handle /v1/*` → `request_body max_size 209715200` + `reverse_proxy 172.18.0.1:3100`; `handle` → SPA at `/srv/reader/web-dist`.
- **Reader stack:** `/srv/reader/docker-compose.yml` — `postgres` (pg17), `api` + `worker` (same GHCR api image; worker runs `epub.process` + `backup.nightly`). **`TAG` in `/srv/reader/.env` = `13987dae1746c3fe2ef099a4fe1a89a89ee2eaac` (slice-2).**
- **Secrets:** `/home/ubuntu/reader/.env` (mode 600): `APP_MASTER_KEY`, Hippius, `ALLOWED_EMAIL=vm.tikkanen@gmail.com`, `MAILER=smtp`, `RDR_HOSTNAME`, `RDR_ENV=prod`.
- **DB access:** `cd /srv/reader && sudo docker compose exec -T postgres psql -U reader -d reader -c "…"`. App schema `app`: now also has `reading_progress` and `settings` (slice-3 migration `0004`).
- **Deploy:** `sudo /srv/reader/deploy.sh <sha>` (in-place web-dist swap + public `/v1/health` gate). **The Caddy `web-dist` bind mount must stay** (`/srv/reader/web-dist:/srv/reader/web-dist:ro` in `/opt/mattermost/docker-compose.yml`); `deploy.sh` swaps in place — never `rm`+`mv` the dir or static 404s.
- **Break-glass code:** `cd /srv/reader && sudo docker compose exec api node dist/cli.js login-code`.

## 4. Gotchas (full list in skill `custom-reader-web`)

1. **S3 `PutObject` rejects lengthless Node streams** — buffer ciphertext to temp file, re-read with known length.
2. **Every process with a pg-boss client must `await boss.start()`** (API *and* worker).
3. **e2e serial** (`workers: 1`) + shared `e2e/mailbox.ts` (see §2); ≤4 `request-code` calls per run.
4. **`verify-code` body = `{email, code, client}`**; cookie mutating calls need `X-Requested-With: reader` + matching `Origin`.
5. **`new Uint8Array(atob(s))` allocates zeros** — use `Uint8Array.from(Buffer.from(s, "base64"))`.
6. **Drizzle circular FKs break tsc** — `documents.cover_asset_id → assets.id` one-way in code, reverse FK hand-written in SQL.
7. **Fastify reply is thenable** — never `await reply.setCookie/clearCookie`.
8. **VPS:** 4 GB RAM, no local image builds / no Playwright (CI only), Docker Hub WAF-blocked, all docker via sudo. Keep unattended shell commands simple (no pipe-heavy one-liners — they trip the security gate).

## 5. Local verification stack

- `e2e/.local-verify.env` + `e2e/docker-compose.local-verify.yml` (gitignored): API `127.0.0.1:3101`, postgres `54329` (`e2e-postgres-1`), s3mock `9000`, console mailer → `/tmp/local-mailbox.log`.
- **As of 2026-11-01:** `e2e-postgres-1` + `e2e-s3-1` Up 2 days (healthy); a local API/worker pair is **still listening on :3101** (pid ~2545856) from the slice-3 verify run. Check `ss -tlnp | grep 3101` before starting your own; only kill local PIDs (prod docker also shows `node dist/server.js`/`worker.js` with cwd `/app/apps/api`, ppid containerd-shim, on :3100 — killing prod is a real incident).
- Clean run: `sudo docker exec e2e-postgres-1 psql -U reader -d reader -c "truncate app.documents, app.document_sections, app.toc_entries, app.assets, app.storage_objects, app.reading_progress, app.settings restart identity cascade"` + `rm -f /tmp/local-mailbox.log`.
- Fixture generator: `node apps/api/tools/make-fixture-epub.mjs /tmp/x.epub`.

## 6. Finish slice 3 (deploy + verify) — the next concrete moves

1. **Re-read** `AGENTS.md`, `PLAN.md` (Slice 3 + Slice 4), `SPECS.md` (progress/settings/signed-URL sections) first — binding.
2. **Confirm CI on `main` still green:** `~/.local/bin/gh run list --limit 1`.
3. **Deploy slice 3:** `sudo /srv/reader/deploy.sh 11c1643` (in-place web-dist swap; gates on `/v1/health`). Update `/srv/reader/.env` `TAG` to `11c1643…` (back up `.env` first). Confirm the Caddy `web-dist` bind mount is intact.
4. **Live-verify the slice-3 owner check** through `https://peisetti.duckdns.org`: log in (break-glass code), open the fixture book, navigate chapters, change theme + font size, close the tab, reopen (ideally a 2nd device / incognito) → land on the same spot. Verify the TOC menu renders and progress restores.
5. **Check prod backup** ran nightly and its `kind`: `… psql -c "select id, kind, created_at from app.backups order by created_at desc limit 4"`. **Known bug (carried from slice 2, still present — see §7):** latest row is `daily` at 2026-11-01 01:00 UTC (03:00 EET Sunday); the worker derives weekday via `getUTCDay()` but the cron is Helsinki-tz, so Sunday-EET = Saturday-UTC and `kind` is always `daily`.
6. **Owner check**, then it's done. Then start Slice 4.

## 7. Open / known gaps

- **Weekly-backup `kind` bug** — the only known functional defect in shipped code. Fix in `worker.ts`: derive the weekday in `Europe/Helsinki`, not `getUTCDay()`. Small; do it before or with Slice 4.
- **Slice-3 deploy is pending** — the one thing not yet done for this slice (see §6).
- **No UI design in the plan.** PLAN.md/SPECS.md specify *behavior* (chapters, next/prev, TOC menu, themes, font size, progress) but no look/layout. The current reader UI (inline styles, `← Previous`/`Next →` pager, nested `<details>` TOC) is a minimal functional implementation — intentional, since PLAN §"Publisher CSS is mostly stripped". If the owner wants a specific look, that's a new decision, not covered by any existing slice.
- No delete-document route (storage rows would orphan) — later slice.
- Backup restore drill — slice 10.
- Section HTML sanitizer is a denylist, not an allowlist — fine for single-user.
- In-memory rate limits reset on restart (single-user app, accepted).

## 8. Slice 4 — what's next (per PLAN.md)

Scope: **Highlights** — canonical text + anchoring in `packages/shared` (golden-file tests), select/save text, re-render on reopen, highlights page; then colours, notes, delete, Markdown export.
**Verify (owner):** highlight across a paragraph break, reload, still there; export to Markdown.
**⚠️ Owner code review before tagging is REQUIRED for slice 4** (canonical text + anchoring — PLAN.md §Testing).
Already scaffolded: `highlights` table placeholder in `schema.ts` (add the migration); canonical-text block-boundary rules in SPECS.md §~84; `GET/POST /highlights` endpoints in the SPECS.md table. Re-read those exact sections before starting.
