# Handoff — end of Slice 1 (Login), start of Slice 2

**Date:** 2026-10-30 · **Repo:** `/home/ubuntu/projects/custom-reader-web` (branch `main`) · **Owner:** vee
**Status:** Slice 1 COMPLETE and owner-verified in production. Next: **Slice 2 (First epub, thinnest path)**.

---

## 1. Where things stand

- **HEAD:** `140e843` — tree clean, `main` pushed. Tags: `slice-0`, `slice-1` (→ `140e843`).
- **CI: GREEN** on final commit (jobs: `test` [lint+typecheck+60 unit tests], `e2e` [Playwright vs postgres + `adobe/s3mock`], `images` [GHCR build+push, tagged with full SHA]).
- **Prod is live and login works end-to-end** — the owner tested it: real email code arrived in Gmail, login succeeded, logged out.
- `docs/slices/slice-1.md` exists (required by AGENTS.md) and was updated with the Caddy mount fix + deploy hardening.

### Slice-1 fixes made after the slice report was first written
All committed on `main` (see `git log --oneline -8`):
1. **Fastify thenable-reply deadlock:** `await reply.setCookie(...)` / `clearCookie(...)` deadlocks the handler (reply.then() resolves on socket end). Fixed by not awaiting, with comments in `apps/api/src/routes/auth.ts`. This was the "verify-code hangs ~15 s" bug.
2. **Caddy static mount:** the mattermost Caddy container needed a `/srv/reader/web-dist:/srv/reader/web-dist:ro` bind mount (added to `/opt/mattermost/docker-compose.yml`, backup `.bak-20261030`). Without it `/` and `/assets/*` 404 while `/v1/*` works.
3. **deploy.sh hardening:** web-dist is now swapped **in place** (never `rm` + `mv` the dir — that orphans Caddy's bind mount to a deleted inode), extraction completeness is asserted, and the final health check curls the public site (`/v1/health` **and** `/`).
4. **Prod config (in `/home/ubuntu/reader/.env`, NOT the repo):**
   - `ALLOWED_EMAIL` was still the slice-0 placeholder → requests for other addresses are **silently** 202 with no mail (by design). Now `vm.tikkanen@gmail.com`.
   - `SMTP_PASS` had a dead Gmail app password (535 Bad Credentials). Now the working one synced from `/etc/mail-gmail/mail.env` (`GMAIL_APP_PASSWORD`) with owner consent.

## 2. Production layout (what exists on the VPS)

- **Domain:** `https://peisetti.duckdns.org` → Caddy (runs inside the Mattermost Docker compose at `/opt/mattermost`, Caddyfile `/opt/mattermost/Caddyfile`).
  - `handle /v1/*` → `reverse_proxy 172.18.0.1:3100`
  - `handle` → `root * /srv/reader/web-dist` + `try_files` SPA fallback + `file_server`
- **Reader stack:** `/srv/reader/docker-compose.yml` — services `postgres` (pg17, internal), `api` (image `ghcr.io/chironreawakened/custom-reader-api:$TAG`, port on 172.18.0.1:3100), `worker` (**same api image**, `command: node dist/worker.js` — the worker container already exists and runs; it currently has nothing to do until slice 2).
- **Secrets:** `/home/ubuntu/reader/.env` (mode 600, never printed/committed): `APP_MASTER_KEY`, Hippius keys, `ALLOWED_EMAIL`, `MAILER=smtp`, `SMTP_USER/SMTP_PASS/SMTP_HOST=smtp.gmail.com/SMTP_PORT=587`, `TAG=<full sha>`. Backups: `.env.bak-20261030`, `.env.bak-20261030-allowem`.
- **Static:** `/srv/reader/web-dist/` (deploy.sh extracts it from the web image; Caddy bind-mounts it — see gotcha 3 above).
- **Deploy:** `sudo /srv/reader/deploy.sh <sha-or-tag>` — pulls images, runs migrations one-off, `up -d`, health-checks bridge IP **and** public site. On failure it prints the roll-back command. The repo copy at `deploy.sh` is the source of truth; sync to `/srv/reader` after editing.
- **Break-glass login code:** `sudo docker compose -f /srv/reader/docker-compose.yml exec api node dist/cli.js login-code`
- **DB access:** `cd /srv/reader && sudo docker compose exec -T postgres psql -U reader -d reader -c "…"` (no host psql).
- **UFW:** 22/80/443 only; compose publishes the API on the bridge gateway IP (172.18.0.1) so Caddy (in-docker) can reach it.

## 3. Gotchas (learned the hard way — read before touching)

1. **Never `await reply.setCookie/clearCookie`** in Fastify handlers (thenable reply → deadlock).
2. **Never replace the `/srv/reader/web-dist` directory itself** (rm+mv, or a new mount) — Caddy keeps a file descriptor on the old inode → silent 404s. Replace *contents*, and if the mount is ever dropped, `docker compose up -d caddy` in `/opt/mattermost` recreates it (Mattermost blips seconds — needs owner OK, it's someone else's stack).
3. **`ALLOWED_EMAIL` mismatches are silent** (202, no mail, no log warning — the 202 is shared with "sent" on purpose). When the owner says "no mail", check this first, then `SMTP_PASS`.
4. **Gmail app passwords die/rotate.** Quick isolated SMTP auth check without touching prod: `sudo docker run --rm -u root -v <envfiles ro> -v <script ro> -w /app/apps/api ghcr.io/chironreawakened/custom-reader-api:$TAG node script.mjs` (a working probe existed at `/tmp/smtp-test.mjs`, may be gone).
5. **Docker Hub is WAF-blocked from this VPS** (registry API, hub web, mirrors all refuse). CI e2e uses `adobe/s3mock` as the S3 stand-in for that reason (MinIO's old Hub tags are pruned anyway). Local verify stack also uses s3mock.
6. **`env_file` values are captured at container creation**: after editing `/home/ubuntu/reader/.env`, use `sudo docker compose up -d api` (recreates), not `restart`.
7. **VPS limits:** 4 GB RAM — **no image builds, no Playwright on the VPS** (CI only). At most one local verify stack at a time. All docker via sudo (ubuntu not in docker group).
8. `gh` CLI is at `~/.local/bin/gh` (owner `chironreawakened`); CI polling: `gh run list --json databaseId,status,conclusion -q '.[0]'` etc.

## 4. Local verification stack (from slice 1, still available)

- `e2e/.local-verify.env` + `e2e/docker-compose.local-verify.yml` (gitignored, live in repo dir): API on `127.0.0.1:3101`, postgres `54329` (container `e2e-postgres-1`), `adobe/s3mock` on `9000`, **console mailer** → codes land in `/tmp/local-mailbox.log` (break-glass CLI also prints codes).
- Start API: `source e2e/.local-verify.env && cd apps/api && pnpm build && node dist/server.js` (background).
- Stack still up as of 2026-10-30 evening; if dead: `docker compose -f e2e/docker-compose.local-verify.yml up -d`.

## 5. Slice 2 — what's next (per PLAN.md, binding: PLAN.md + SPECS.md)

Scope: **First epub, thinnest path**
1. Epub upload (streamed through API, **encrypted on the fly** in RDR1 format before it ever touches Hippius; 200 MB max — note: Caddy's `request_body` limit is **not yet configured** for `peisetti`, and neither is the API-side limit; both are in scope here).
2. Worker job (pg-boss on Postgres, `worker` service already exists): unzip → parse OPF + nav/NCX TOC (spine+headings fallback) → extract images → sanitize sections → store sections + assets in Hippius (bucket `custom-reader`, `parser_version`, `dc:language` → `english|finnish|simple`).
3. **DRM detection → reject with a clear message.**
4. Library list (titles only) + reader: chapters, images via **short-lived signed URLs** (SPECS §3 — `asset:<id>` placeholders rewritten at serve time), next/prev.
5. **Nightly DB backup** worker job: `pg_dump` → RDR1-encrypted → Hippius; retention 14 daily + 8 weekly (restore drill is slice 10).
6. Playwright e2e for the tracer path (CI) + unit tests for risky logic (epub parsing, signed URLs); fixture epubs live in the repo (good, bad TOC, no TOC, DRM, huge images, Finnish).

**Owner verification for slice 2:** upload a real book, read it with pictures; a backup object appears the next day.

Key specs to re-read before starting (AGENTS.md says re-read relevant sections each slice): SPECS §2 (RDR1), §3 (signed URLs), §4 (CSRF — uploads need it too), §5 if present (uploads/limits), §11 (schema — new tables via Drizzle migrations; never edit applied migrations), §12 (error shape).

## 6. Suggested first moves for the next session

1. `git log --oneline -8` + read `SPECS.md` §2/§3/§5/§11/§12 + `PLAN.md` slice 2 section.
2. Check CI status on `main` is still green (nothing should have changed, but confirm).
3. Design the new tables (`documents`, `sections`, `assets`, `jobs` state, `backups`) as a Drizzle migration; keep the storage layer thin.
4. Reuse the existing `worker` container/command — it's already in prod compose.
5. Remember: every slice ends with `docs/slices/slice-N.md` + tag `slice-N` + deploy + live verify + owner check before the next slice.

## 7. Open/known gaps

- Caddy `peisetti` site has **no `request_body` size limit** yet (200 MB rule is planned for slice 2).
- The `worker` service in prod runs the same image as the API — its `TAG` updates on the same deploy; fine, but remember worker restarts on every deploy.
- Local verify stack left running (API :3101, pg :54329, s3mock :9000) — stop it if memory gets tight (4 GB box; ~1 GB used by prod stack + Mattermost).
- Gmail 535 rejections will happen again if the app password is regenerated — the working password currently lives in BOTH `/home/ubuntu/reader/.env` (`SMTP_PASS`) and `/etc/mail-gmail/mail.env` (`GMAIL_APP_PASSWORD`, used by msmtp/logwatch); keep them in sync or re-test with the throwaway SMTP probe.
- No `ALLOWED_EMAIL` warning in logs (deliberate silent 202) — document-worthy if it bites again; could add a structured warn log later (owner decision).
