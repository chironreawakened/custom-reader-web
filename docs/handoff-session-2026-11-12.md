# Handoff — session 2026-11-12 (TTS deployed, next slice unstarted)

## Where we left off

- **Repo** `~/projects/custom-reader-web`, branch `main`, HEAD `67a90ca`
  ("docs(slice-7): done — CI e2e green"). Clean worktree. pnpm 10 at
  `~/.local/bin/pnpm`; local Node 26, CI/prod images `node:24-alpine` —
  **CI (fresh postgres) is the authoritative gate** over local e2e.
- **Prod** `/srv/reader/` is **DEPLOYED + VERIFIED** at
  `TAG=67a90cae564e364b130ea2b9e4b8f0e15bf81e58` on `peisetti.duckdns.org`
  (api + worker on that image; postgres 13 days, healthy, migrations
  applied incl. `0008` `tts_cache`). `/v1/health` 200, live bundle contains
  the TTS code. No dev stack running; port 3101 free.
- **Slice 7 (TTS) is complete in the repo** (CI 5/5) and **just deployed**.
  The owner was told how to test it manually (Settings → paste OpenAI key →
  pick voice → TTS toggle in a book/article). **Awaiting owner feedback** on
  whether it actually plays audio for them.

## FIRST things to do this session

1. **Ask the owner how the TTS manual test went** before starting anything.
   If it's broken, that is the priority (check the owner's OpenAI key is
   stored: `PUT /v1/tts/key`; worker job `JOB_TTS_CHUNK` calls
   `api.openai.com` by default — no base-URL override in prod `.env`).
2. **Slice 7 is missing its git tag.** `git tag` currently stops at
   `slice-6`. Per AGENTS.md a slice is not "done" until it is tagged
   `slice-N` and pushed. If the owner confirms TTS works, create and push
   tag `slice-7` at `67a90ca` (normal fast-forward tag, not a force-push —
   no consent needed). Do **not** create it until the owner confirms, in
   case a TTS fix moves the head first.

## Open bug (deprioritized by owner — do NOT chase unprompted)

PDF highlight "text moves" defect, slice-6 territory. Full detail in
`docs/handoff-pdf-highlight-bug.md` (committed `282dbc2`). One sub-bug
(opaque-black mark text + mark reconciliation) was fixed and deployed in
`5d2fe56`; the movement itself is **unfixed** — leading hypothesis is the
hand-rolled text layer is metrically misaligned with the canvas ink so the
highlight band is off from the glyphs. Owner explicitly said to move on.

## Housekeeping / standing items

- **`slice-6` remote tag still points at `c8ebbbc`** (pre-fix). Owner never
  consented to force-moving it; CI/deploy key off the SHA so it's cosmetic.
  Ask if it ever matters.
- Local verify env: `e2e-postgres-1` (127.0.0.1:54329) + `s3mock` (:9000)
  via `e2e/docker-compose.local-verify.yml`; run API+worker from
  `apps/api/dist` on :3101 with `e2e/.local-verify.env`
  (`ALLOWED_EMAIL=e2e@reader.test`, `CONSOLE_MAILBOX=/tmp/local-mailbox.log`).
  **Port 3101 is public — never leave it up.** Local DB is polluted with
  duplicate fixture docs → expect local e2e book-section flakes; CI fresh-DB
  doesn't flake. 5 login codes / 15 min / IP, in-memory (restart resets).
  A `down --volumes` on the CI stack wipes the shared `e2e-postgres` and you
  must re-`ALTER ROLE reader PASSWORD …` (stale-hash 28P01 lesson).
- Break-glass login for owner testing:
  `sudo docker compose -f /srv/reader/docker-compose.yml exec -T api node
  dist/cli.js login-code` (mints a code for vm.tikkanen@gmail.com — hand it
  to the owner in chat, never log it).
- `tmp/` scratch scripts are uncommitted by design (usable as starting
  points). Never commit `tmp/`.
- Never include secrets/tokens/codes in any record — use [REDACTED].

## Next slice (only after owner says go)

**Slice 8: Search** (PLAN.md line ~154). Per AGENTS.md: read PLAN.md +
SPECS.md fully first, work one slice at a time, don't start until the owner
says so. Slices 8 and 9 (search; PDF reflow — the latter unblocks PDF
read-aloud) remain, then 10 (hardening/RN handoff).

## Relevant commits (newest first)

`67a90ca` docs slice-7 done · `bf9c510` fix(e2e) audio listener ·
`2716ca4` docs slice-7 honest status · `9147de1` fix(web) degenerate-node ·
`282dbc2` docs: PDF-highlight handoff · `5d2fe56` **fix(web) PDF highlight
(mark color + reconciliation) — deployed** · `0044b7c` docs slice-6 ·
`1c41c7d` render-race fix · `a92d9fb` Node-24 pdfjs legacy build.
