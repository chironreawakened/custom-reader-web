# Personal Reader — Plan

Single-user, self-hosted Readwise-Reader-like app. Web first, React Native later against the same API.

- **PLAN.md** (this file): what we build and in what order.
- **SPECS.md**: exact, binding specifications (crypto format, auth, canonical text, anchors, schema, API).
- **AGENTS.md**: rules for the implementing agent.

Built by an autonomous agent (Hermes) on the VPS, one tracer-bullet slice at a time, stopping after each slice for owner verification.

## Stack
- **Monorepo** (pnpm workspaces) on GitHub.
  - `apps/web`: Vite + React SPA, TanStack Router + TanStack Query.
  - `apps/api`: Fastify API + worker (same codebase, separate process/container), Drizzle ORM + migrations, pg-boss job queue on Postgres.
  - `packages/shared`: zod schemas (source of the OpenAPI spec), API types, reader model, canonical text + anchoring. Reused by the RN app.
- **Versions**: Node 24 LTS, Postgres 17, pnpm 10, Caddy 2 (current stable). Exact versions are pinned in `package.json` `engines`/`packageManager`, Dockerfiles and the lockfile at slice 0.
- **Postgres**: metadata, highlights, FTS, sessions, jobs.
- **Hippius** (S3-compatible): all content, **always encrypted before upload** (SPECS §2). The storage layer is kept thin so a fallback can be added later; none is built now. Separate buckets for dev and prod.
- **HTTPS**: Caddy with a Let's Encrypt cert for a **DuckDNS hostname** (HTTP-01, ports 80/443). Caddy also serves the built web app as static files, so there is no separate web container.

## Environments on one VPS (4 GB RAM, Ubuntu)

| | Prod | Dev (agent) |
|---|---|---|
| Linux user | owner | `hermes` (unprivileged, **not** in `docker` group, no sudo) |
| Location | `/srv/reader` | `/home/hermes/reader` |
| Runs | Docker Compose project `reader-prod`: caddy (+web), api, worker, postgres | Rootless Docker (Postgres only), API/worker/web via `pnpm dev` on 127.0.0.1 |
| Secrets | `/srv/reader/.env`, mode 600, owner-only | `/home/hermes/reader/.env`: dev master key, dev Hippius bucket, console mailer |
| Storage | Hippius prod bucket | Hippius dev bucket |

- The agent never reads prod secrets, touches prod containers or deploys. Docker group membership would be root-equivalent and expose prod, hence rootless Docker for the agent.
- If Hippius access keys can't be scoped to one bucket, the agent's key could reach prod data. The data would still be ciphertext, since the agent has no prod master key, but it could be deleted. In that case use a separate Hippius account for prod.
- **Memory budget**: prod ≈ 1–1.3 GB (Postgres tuned to ~256 MB shared_buffers, api + worker ~400 MB, Caddy ~50 MB). Dev ≈ 1–1.5 GB. Hermes itself is assumed to use a remote model API. Add a **4 GB swap file**. No image builds and no Playwright on the VPS.

## CI / CD
- **GitHub Actions** (on every push to `main`):
  - lint, typecheck, unit tests
  - Playwright e2e against the Compose stack, with MinIO standing in for Hippius and the console mailer
  - dependency audit
- On green, Actions builds the `api` (also used for the worker) and `caddy` (with the web build baked in) images and pushes them to **GHCR**, tagged with the commit SHA.
- **Deploy** (owner only): `sudo /srv/reader/deploy.sh <sha-or-tag>` runs `compose pull`, then the migrations as a one-off container, then `up -d`, then a health check. On a failed health check it rolls back to the previous tag. The agent writes this script and the owner runs it.
- No secrets in GitHub Actions except the built-in `GITHUB_TOKEN`.

## Users and auth
Single user; every table still has `user_id`. Signup is closed: only `ALLOWED_EMAIL`.
- Login is an **emailed 6-digit code**, with no passwords or links. It's sent via Gmail SMTP with an app password, to the owner's own address, behind a `Mailer` interface. A console mailer is used in dev and CI.
- Attempt caps, rate limits, sessions, CSRF: SPECS §4.
- **Break-glass**: `docker compose exec api node dist/cli.js login-code` prints a valid code.
- Web uses an HttpOnly cookie; RN uses a bearer token. Both work from slice 1.

## Content model
Every source normalizes to Document → ordered Sections (sanitized HTML stored encrypted in Hippius) → TOC tree, plus Assets (images, cover, original). Schema: SPECS §11.
- Images in stored HTML are `asset:<id>` placeholders, rewritten to **short-lived signed URLs** when served (SPECS §3). Works for `<img>`, pdf.js and RN alike.
- Server-side sanitizing with a tag/attribute allowlist. **Publisher CSS is mostly stripped**: only image sizing and basic emphasis/alignment are kept.
- The web reader renders sections in a **shadow DOM** under a strict CSP.
- `parser_version` allows re-processing. Highlights survive it because they are quote-anchored.

## Ingestion (worker jobs)
- **Uploads** are streamed through the API, encrypted on the fly, to Hippius. Max 200 MB, enforced in Caddy and the API.
- **Epub**:
  - Unzip and parse the OPF and nav/NCX TOC. If the TOC is missing or broken, fall back to spine order with titles from headings.
  - Extract images, sanitize, store the sections, and read `dc:language`.
  - Detect DRM and reject those files with a clear message.
  - Fixed-layout epubs and comics are out of scope.
- **URL articles**:
  - SSRF-safe fetch: block private, link-local and loopback IPs, re-validate after DNS resolution and on every redirect, and limit size and time.
  - Extract with Readability (jsdom).
  - Re-host images, including `srcset`, `data-src` and other lazy-load patterns, then sanitize.
  - There is no headless browser, so JS-only sites fail gracefully.
- **PDF**:
  - *Faithful mode* (default): pdf.js loads the original through a signed, range-capable asset URL, and the PDF outline is used as the TOC.
  - *Reflow mode* (beta): server-side text extraction into sections, with heading detection.
  - Scanned PDFs with no text layer get a clear message, with no highlights, no reflow and no OCR.
- **Language**: taken from epub metadata or the article's `<html lang>`, with statistical detection as a fallback. Stored as `english`, `finnish` or `simple`.

## Highlights, progress, search, TTS
- **Highlights**: text-quote anchors over a shared canonical text (SPECS §6–7). Colours, notes, soft delete and Markdown export. Highlights made in PDF faithful mode and in reflow mode are separate (accepted).
- **Progress**: a locator plus last-write-wins (SPECS §8).
- **Search**: Postgres FTS with english, finnish and simple configs. Only the tsvector of section text is stored in Postgres (SPECS §9).
- **TTS**:
  - The server proxies OpenAI with the stored, encrypted key.
  - Chunks are paragraph-sized and built on the server; clients request them by index only.
  - Audio is cached as encrypted objects, and the player prefetches upcoming chunks (SPECS §10).
  - Sentence highlighting uses estimated timing.

## Backups
- Starting in slice 2, the worker runs a nightly `pg_dump`, encrypts it in the `RDR1` format and uploads it to the prod Hippius bucket. It keeps 14 daily and 8 weekly backups.
- The DB dump plus `APP_MASTER_KEY` is enough to restore, since the content already sits encrypted in Hippius.
- The restore drill happens in slice 10.

## Method: tracer bullets
Each slice is a thin, end-to-end path through every layer and ends with a **"you can verify"** check. Every slice ends the same way:
1. CI is green.
2. The agent writes `docs/slices/slice-N.md` (what was built, how to verify, known gaps) and tags the commit `slice-N`.
3. The agent **stops**.
4. The owner deploys and verifies, then tells the agent to continue.

### Slice 0: Walking skeleton
- Monorepo, Drizzle and the first migration (`users`, `storage_objects`).
- `RDR1` encryption module with the full test suite from SPECS §2.
- Thin S3 client. **Verify that Hippius supports ranged GETs** (and stop if not).
- `GET /v1/health`, which checks the DB and an encrypted round trip to storage, plus a web page showing the result.
- Production Dockerfiles, Compose files (prod + CI), Caddyfile, `deploy.sh`, GitHub Actions with GHCR images.
- `docs/owner-setup.md`, the owner's step-by-step VPS setup for prod.

**Verify**: after you deploy, `https://<name>.duckdns.org` shows "api ok / db ok / storage ok (encrypted)", and the test object in Hippius is unreadable ciphertext.

### Slice 1: Login
- Request a code, send it via Gmail SMTP, verify it, create a session, `GET /v1/me` shows "Hello <email>", logout.
- Attempt caps, rate limits, closed signup, CSRF, bearer tokens, break-glass CLI.

**Verify**: log in from your phone with a real emailed code, then log out.

### Slice 2: First epub, thinnest path
- Upload an epub, process it in a job, store sections and images encrypted in Hippius.
- Library list (titles only), and a reader with chapters, images through signed URLs, and next/prev.
- Nightly DB backup.

**Verify**: upload a real book and read it with pictures. A backup object appears the next day.

### Slice 3: TOC, progress, reader basics
TOC menu (with fallbacks), themes and font size, progress sync, covers, DRM detection, language detection.

**Verify**: close the tab, reopen on another device, and land on the same spot.

### Slice 4: Highlights
- Canonical text and anchoring in `packages/shared`, with golden-file tests.
- Select text, save it, and see it re-rendered on reopen. Highlights page.
- Then colours, notes, delete and Markdown export.

**Verify**: highlight across a paragraph break, reload, and it's still there. Export to Markdown.

### Slice 5: URL articles
- Add a URL, fetch it SSRF-safely, extract with Readability, re-host the images, and read it in the same reader with the same highlights.
- Inbox/Later/Archive and tags.

**Verify**: save a real article with lazy-loaded images, highlight it, and archive it.

### Slice 6: PDF faithful
Upload a PDF; pdf.js loads it with range requests; outline menu; progress; text-layer highlights.

**Verify**: a large PDF opens quickly, you can navigate by the outline, and you can highlight.

### Slice 7: TTS
- Settings page for the OpenAI key, then TTS of one chunk.
- Then prefetch, the encrypted cache, sentence highlighting and player controls.

**Verify**: listen to a chapter, and a replay makes no second OpenAI call.

### Slice 8: Search
FTS with the english, finnish and simple configs, and a search UI over the library and highlights.

**Verify**: a Finnish word finds its inflected forms in a Finnish book.

### Slice 9: PDF reflow mode
Text extraction into sections, read in the normal reader, with TTS for PDFs.

### Slice 10: Hardening and RN handoff
Backup restore drill, a review of CSP and headers, the OpenAPI spec generated from zod, and API docs for the RN app.

## Testing
- Every slice adds at least one Playwright e2e test of its tracer path (run in CI only). It also adds unit tests for risky pure logic: the encryption format, canonical text and anchoring, the SSRF guard, OTP, epub parsing and signed URLs.
- A fixture corpus lives in the repo:
  - epubs: good, bad TOC, no TOC, DRM, huge images, Finnish
  - PDFs: with outline, without outline, scanned
  - saved article HTML
- **Owner code review before tagging** is required for slice 0 (encryption) and slice 4 (canonical text and anchoring).

## Owner setup (before slice 0)
1. Hippius: create **two** buckets (dev, prod) with keys scoped per bucket if possible.
2. Generate a **dev** `APP_MASTER_KEY` for the agent, and later a separate **prod** one (`openssl rand -base64 32`). Save the prod key in a password manager. **Losing the prod key means losing all content.**
3. Create an empty GitHub repo. Give Hermes a fine-grained token for that repo only (contents read/write). Add a ruleset on `main` that **blocks force pushes and branch deletion**.
4. On the VPS:
   - Create the `hermes` user (no sudo) and set up rootless Docker for it.
   - Add 4 GB of swap.
   - Allow only ports 22, 80 and 443 in ufw.
   - Install Docker for the owner.
5. DuckDNS: pick a name and point it at the VPS IP.
6. Before slice 1: turn on Google 2-step verification and create a Gmail app password (prod `.env` only).

`docs/owner-setup.md` (written in slice 0) turns the VPS part into exact commands.

## Out of scope (for now)
Offline mode, OCR, fixed-layout epubs, headless-browser article fetching, storage fallback, multi-user, other TTS providers, the RN app itself.
