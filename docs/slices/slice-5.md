# Slice 5 — report (2026-11-03)

Slice 5 scope from PLAN.md: **URL articles** — add a URL, fetch it
SSRF-safely, extract with Readability, re-host the images, and read it in the
same reader with the same highlights; plus Inbox/Later/Archive status and tags.

## What was built

- **Shared contracts** (`packages/shared/src/documents.ts`):
  - `PostUrlBody` / `PostUrlResponse` — the `POST /v1/documents/url` contract
    (accepts `{url}`, returns the created doc + `sectionsCount`).
  - `PatchDocumentBody` — partial `status` (inbox/later/archive), `title`,
    `author`, `language`, `tagIds` (SPECS §11–12).
  - `TagItem` / `ListTagsResponse` — the per-user tag list.
  - `documentMeta.tags` carries tag **names** (not ids) so the list response
    stays a single fetch; the web maps names→ids via the tag list before
    PATCHing `tagIds`.

- **SSRF-safe fetch** (`apps/api/src/services/ssrf/safe-fetch.ts`, 19 unit tests):
  The core security work of the slice. Instead of a naive
  `fetch(userUrl)`, the fetcher resolves DNS **itself** through an undici
  `buildConnector` with a custom `lookup`, vets the IP **before** connecting,
  then pins the connection to that exact IP so the browser/worker never dials
  whatever the hostname re-resolves to after the check (TOCTOU).
  - Block-list: all private/loopback/link-local ranges for IPv4 **and** IPv6
    (`::1/128`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96` v4-mapped),
    `0.0.0.0`, multicast, and the whole non-global space.
  - **Every redirect is re-vetted** (max 5 hops): a public page that 302s to
    `http://169.254.169.254/...` or an internal IP is refused, not followed.
  - Loopback is **off by default** and only allowed under `RDR_ENV=ci`
    (the e2e article server binds 127.0.0.1); production keeps it denied.
  - Non-`http`/`https` schemes and missing host are rejected up front.
  - Errors are a typed `SsrfError` so the route maps to a clean
    `400 bad_request { reason }` instead of leaking a 500.

- **Readability extraction** (`apps/api/src/services/article/extract.ts`, 6 tests):
  `@mozilla/readability` running over a `linkedom` DOM (no headless browser,
  per the out-of-scope list). Returns the extracted `<article>` HTML, canonical
  text, detected `lang`, and a title. Relative asset URLs are rewritten against
  the source page. `ARTICLE_PARSER_VERSION = 1` is stamped on the doc so a
  future parser change can re-extract cleanly.

- **Worker** (`apps/api/src/worker.ts`, `jobs/boss.ts`):
  New boss job `article.process`. On claim, `processArticle` re-fetches the
  source (same SSRF guard), extracts, **re-hosts every image** through the
  existing signed-URL asset pipeline (so a dead source page doesn't blank the
  article later), writes a **single section**, and marks the doc `ready` with
  `wordCount`. A single section means the existing slice-2/3/4 reader and
  highlight anchoring work unchanged — no reader changes were needed.

- **Documents routes** (`apps/api/src/routes/documents.ts`, 15 slice-5 tests):
  - `POST /v1/documents/url` — validates scheme/host, creates the doc
    (`document_type='url'`, `ingest_state='pending'`, title = source URL as a
    placeholder), enqueues `article.process`, returns `201`.
  - `PATCH /v1/documents/:id` — `status`/`title`/`author`/`language`/`tagIds`;
    tag changes are a full replace (delete-then-insert the user's tags on the
    doc).
  - `DELETE /v1/documents/:id` — `204`, cascades sections/assets/highlights.
  - `?tag=` filter on the library list (server-side, joins
    documentTags→tags).
  - `tagsFor(docIds, userId)` helper shared by list + detail so a doc always
    carries its tag names.

- **Tags routes** (`apps/api/src/routes/tags.ts`, 4 tests):
  `GET /v1/tags` (list), `POST /v1/tags` (create, **idempotent** — the
  `tags_user_name_unique` index makes a same-name retry return the existing
  row instead of 409; a real race is caught and re-looked-up so two
  concurrent creates resolve to one winner), `DELETE /v1/tags/:id` (removes
  the tag + all its doc links).

- **Web** (`apps/web/src/main.tsx`, `api.ts`):
  - Library rebuilt around the new model: an **Add article URL** button +
    inline form (`add-url-*` testids), a per-row **type badge** (book/article),
    an **IngestBadge** (queued…/ready/failed), **status select**
    (inbox/later/archive) per row, and a **tag chip + add-tag** affordance per
    row.
  - A **tag filter bar** above the list (chips + "all") driving the `?tag=`
    server filter.
  - New `api.ts` methods: `addUrl`, `listTags`, `createTag`, `deleteTag`,
    `patchDocument`, `deleteDocument`, and `listDocuments(tag?)`.
  - The article's title/author are read from the doc (worker-updated), so the
    row shows the real headline, not the URL, once it's ready.

- **e2e** (`e2e/documents.spec.ts` + `e2e/tools/article-server.mjs`):
  A tiny loopback article server (`127.0.0.1:3210`) serves one realistic HTML
  page (with a lazy-style image). The spec starts it in `beforeAll`, POSTs its
  URL through the UI, and waits for the reader to render the extracted body.
  It **piggybacks the existing single login** in the same spec (the e2e
  request-code budget is already full at 4 across the suite, so no new login).
  The fixture server is committed; only `.local-verify.env` and the local
  compose file stay out of git.

## Verified (real output, 2026-11-03, local verify stack)

Local stack: `e2e-postgres-1` (54329) + `s3mock` (9000) + API + worker on
127.0.0.1:3101, `MAILER=console`; migration 0006 applied before boot.

- Gates: `pnpm build` green; `pnpm -r lint` / `typecheck` 4/4; **API unit
  tests green** — 19 safe-fetch + 6 extract + 15 documents-slice5 + 4 tags,
  on top of the prior suite (230 total in the API project).
- Live curl loop (session cookie from the console mailbox):
  - `POST /v1/documents/url` → `201` `pending` doc + queued boss job; worker
    picked it up and logged `ready (article, 85 words, 1 images)` — the image
    was re-hosted to a signed asset URL.
  - Detail after processing: `ingestState=ready`, real title
    `Test Article Headline — E2E News`, author `E2E Author`, `wordCount=85`,
    `sectionsCount=1`; the section body carried the article paragraphs and
    **not** the nav/footer junk (Readability stripped it).
  - Tags: `POST /tags {e2e-article}` → `201`; `PATCH` doc with that tag +
    `status=later` + new title → `200` (row updated); `?tag=e2e-article`
    filtered the list to just that doc; `DELETE` doc → `204`.
  - SSRF guard live: `POST /v1/documents/url` with a `file://` URL → `400`
    `bad_request` (not a 500, not a fetch).
- Browser (real Chromium, :3101 serving the built web UI):
  - Signed in (session cookie), library showed the two docs.
  - **Add article URL** → typed the fixture URL → submitted → the new row
    appeared as `queued…`, then flipped to `ready` with the real headline and
    author once the worker finished.
  - Opened the article → the reader rendered the extracted body (lighthouse /
    coffee-queue paragraphs present, "E2E News" footer absent).
  - Per-row **+ tag** → typed `e2e-article` → the chip appeared on the row and
    in the **tag filter bar**; clicking the chip narrowed the list to the one
    article, "all" restored both rows.

## How the owner verifies (post-deploy)

1. `curl https://peisetti.duckdns.org/v1/health` → `api/db/storage ok`.
   (Migration 0006 runs in the API container entrypoint — no manual step.)
2. Log in at `https://peisetti.duckdns.org/`.
3. Library → **Add article URL** → paste a real article (ideally one with
   lazy-loaded images) → the row appears as `queued…`, then flips to `ready`
   with the real headline + author.
4. Open it → the article reads in the normal reader (nav/footer stripped,
   images load from the re-hosted signed URLs). **Highlight a passage**,
   reload → the highlight is still there (same anchor code as books).
5. Per row: switch **Inbox / Later / Archive**, and add a **tag**. The
   **tag filter bar** at the top of the library lists your tags — click one to
   narrow, "all" to restore.

## Known gaps / follow-ups

- **No owner code review was required** for slice 5 (only slice 0 encryption
  and slice 4 canonical-text/anchoring carry that gate in PLAN.md). The SSRF
  guard is the riskiest new logic; it is unit-tested (19 cases) and was
  exercised live, but it is a new durable security boundary — worth a read.
- Loopback article fetching is **only** enabled under `RDR_ENV=ci`. Production
  denies 127.0.0.1/private ranges, so a saved URL can't be an internal host.
- The e2e article flow reuses the existing login; the 4-call request-code
  budget means a *new* spec can't log in on its own until the budget grows.
- Readability over linkedom is heuristic: a page with an unusual structure may
  extract a narrower `<article>` than a human expects. If a saved article
  looks truncated, re-running extraction (bump `ARTICLE_PARSER_VERSION`) is the
  clean path.
- Images are re-hosted at ingest; a source image that 404s **at fetch time**
  simply isn't re-hosted (the article still saves with the rest).
