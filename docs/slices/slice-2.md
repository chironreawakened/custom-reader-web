# Slice 2 — report (2026-10-31)

Slice 2 scope from PLAN.md: **EPUB upload + parsing + presentation** —
streaming encrypted upload, background parsing (pg-boss), reader API
(TOC / sections / signed asset URLs), the web reader UI, a nightly
Postgres backup job, tests (unit + Playwright e2e), Caddy 200 MB cap.

## What was built

- **Migrations 0002 + 0003** (drizzle-generated):
  - 0002: `app.documents` (id, user_id, type, title, author, language,
    word_count, ingest_state, ingest_error, created_at) and
    `app.document_sections` (spine-ordered sections with title,
    html_object_id, prev/next).
  - 0003: `app.assets` (kind, mime, width/height, object_id) +
    `documents.cover_asset_id` FK. The reverse FK is declared by hand in
    the SQL (Drizzle two-way circular FKs break TS 5.9 inference — see
    skill notes).
- **RDR1 streaming** (`storage/rdr1-stream.ts`, shared `rdr1.ts`
  extended): `streamEncrypt` / `streamDecrypt` split the plaintext into
  64 KiB RDR1 segments so an arbitrary-size upload is encrypted in
  streaming fashion; per-segment DEKs wrapped with the object key.
- **Object store** (`storage/object-store.ts`): thin
  `ObjectStore` over `S3Storage` (the only S3 touch point).
  `putCiphertextStream` buffers the ciphertext to a temp file, reads it
  back, and uploads with a known length (S3 `PutObject` rejects
  lengthless Node readable streams — found live, see below).
- **EPUB parser** (`services/epub/parse-epub.ts` + `image-size.ts`,
  `mime.ts`): JSZip + @xmldom/xmldom. Reads OPF metadata (title/author/
  language/word count), spine, TOC (EPUB 3 nav map first, NCX fallback,
  spine order-of-appearance fallback), extracts images (PNG/JPEG/GIF
  sizes read from headers, no image lib) into `app.assets`, rewrites
  `<img>` srcs to `asset:<id>` markers, sanitizes section HTML (strips
  script/style/inline handlers), picks the cover via `cover-image`
  meta or `properties="cover"` item.
- **pg-boss queues** (`jobs/boss.ts`, `worker.ts`):
  - `epub.process` — parse, extract, persist sections + assets, set
    `ready`/`failed`.
  - `backup.daily` (cron `0 3 * * *` Europe/Helsinki) — `pg_dump
    --schema=app --format=plain` encrypted into the object store.
  Queue options set once via `createQueue(name, {…})` before
  `work()`; **every** process holding a boss client must `start()`
  first (API sender included).
- **Documents API** (`routes/documents.ts`):
  - `POST /v1/documents/upload` (multipart, 200 MB cap in Fastify;
    streaming RDR1 → object store → `documents` row `pending` →
    `epub.process` job)
  - `GET /v1/documents` (list), `GET /v1/documents/:id` (meta incl.
    cover URL), `GET /:id/toc`, `GET /:id/sections`,
  - `GET /:id/sections/:sid` — decrypted section HTML with
    `asset:<id>` rewritten to **HMAC-signed URLs**
    (`/v1/assets/<id>?exp=…&sig=…`, 10 min expiry, subkey-derived)
  - `GET /v1/assets/:id` — signed-URL gate; full or ranged GET (206).
  - CSRF guard (shared `services/csrf.ts`) on all cookie-authed
    mutating routes.
- **Web UI** (`apps/web/src/`): library list (poll 10 s, per-book
  ingest badge), upload button (hidden file input), reader view
  (TOC, cover, word count, prev/next) — TanStack Query, thin fetch
  client in `api.ts`. `#hello` greeting kept for the login e2e.
- **Tests**:
  - unit (18 new): `parse-epub.test.ts` (10, over a JSZip-built
    fixture EPUB via `fixture-epub.ts`), `rdr1-stream.test.ts` (5,
    round-trips through the real `Rdr1`), `image-size.test.ts` (3).
  - e2e (`e2e/documents.spec.ts`): login → upload fixture EPUB via the
    file input → wait for the `ready` badge → open book → assert TOC,
    cover (signed URL, decodes), section text, prev/next, edge
    disabling. Fixture generated at test time by
    `apps/api/tools/make-fixture-epub.mjs`.
  - CI `e2e` job now starts the **worker** too (API alone can't
    process uploads) + `REPO_ROOT` for fixture generation.
- **Caddy** (`Caddyfile.reader`): `request_body { max_size 209715200 }`
  on the `/v1/*` handle (the API's own 200 MB limit is the second
  layer).
- **Dockerfile**: `apk add postgresql-client` (worker's `pg_dump`).

## Verified (real output, 2026-10-31, local verify stack)

Local stack: postgres:17 + adobe/s3mock + locally built API + worker,
`MAILER=console`.

- `pnpm -r lint` / `typecheck` / `test`: green — 63 shared + 33 api
  unit tests (18 new) passing.
- Full live curl loop: request-code → verify (code from
  `/tmp/local-mailbox.log`) → `POST /v1/documents/upload` → **201** →
  worker flips the doc to `ready` → `GET` meta (title/author/language/
  wordCount/cover), `/toc`, `/sections`, section HTML (decrypted,
  images rewritten to signed URLs, prev/next populated),
  `GET /v1/assets/:id` full 200 + `Range` 206 + tampered `sig` → 401.
- Browser (real Chromium): login with the mailed code → library shows
  the book → reader renders the section → TOC link jumps to Chapter
  Two → cover image loads from a signed asset URL → **uploaded a new
  EPUB through the file input** — it appeared, got ingested, and its
  title was taken from the EPUB metadata.
- CI: `test` + `images` green; `e2e` green after the serial-execution
  fix (below).

### Bugs found & fixed during verification
- **S3 `PutObject` rejected the lengthless ciphertext stream**
  (`ERR_HTTP_INVALID_HEADER_VALUE`): upload 201'd, then the worker
  had nothing to read. Fixed by buffering to a temp file and uploading
  with a known length (the 200 MB cap bounds memory). Typecheck and
  unit tests never catch this — only a real upload against s3mock did.
- **The API's pg-boss client was never started**: `boss.send()` threw
  inside pg-boss (db not opened), the route's catch swallowed it →
  upload 201, job never existed, doc stuck `pending`. First check
  after a stuck upload: `select count(*) from pgboss.<queue>`.
- **e2e race**: parallel Playwright workers both log in as the single
  `ALLOWED_EMAIL`; codes are single-use, so whichever worker read the
  other's code 401'd. Fixed: `workers: 1` + each login reads only
  mailbox lines written *after* it requested its code.
- **`new Uint8Array(atob(s))` allocates zeros** (string = length): the
  first hand-typed PNG fixtures were silently corrupt. Use
  `Uint8Array.from(Buffer.from(s, "base64"))` and generate fixture
  images with a real encoder.

## How the owner verifies (post-deploy)

1. `curl https://peisetti.duckdns.org/v1/health` → `api/db/storage ok`.
2. Open `https://peisetti.duckdns.org/` → login (email + code as in
   slice 1).
3. Library view: upload a real EPUB (≤ 200 MB) → the row shows
   `queued…`/`processing…`, then `ready`.
4. Click the book: TOC, cover, first section; prev/next walks the
   spine; images load (signed URLs).
5. Backup: after ~03:00 EET the next day,
   `select count(*) from app.storage_objects` (or the worker log)
   shows a new encrypted dump object; nothing is exposed via the API.

## Known gaps / follow-ups
- CDP-free single-user app: in-memory rate limits (slice 1) reset on
  restart — unchanged.
- Backup is a `pg_dump` of schema `app` only (not the pgboss schema —
  intentional; it holds no user data). No restore drill yet.
- No delete-document route yet (storage rows would leak) — later
  slice per PLAN.md.
- Section HTML is sanitized against an element/attribute denylist, not
  a strict allowlist; acceptable for personal single-user use,
  flagged if this ever becomes multi-tenant.

## Deviations
- The upload route is `POST /v1/documents/upload` (PLAN.md implied
  `POST /v1/documents`); the explicit subpath keeps the collection
  route clean for a future PATCH.
- Images are stored as separate objects and referenced by signed URL
  (PLAN.md's "assets with signed URLs" — implemented exactly).
