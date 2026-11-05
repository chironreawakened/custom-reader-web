# Slice 6 — report (2026-11-04)

Slice 6 scope from PLAN.md: **PDF faithful** — upload a PDF, pdf.js loads it
with range requests, outline menu, progress, text-layer highlights. Fixture
corpus: PDFs with outline, without outline, and scanned.

## What was built

- **Fixture generator** (`apps/api/tools/make-fixture-pdf.mjs`, no deps —
  hand-assembled PDF 1.4): three variants, all verified through the real
  `parsePdf` —
  - `outline` (default; 2 pages of text, 2-entry outline with page
    destinations, `/Title` + `/Author`, byte-stable so e2e assertions never
    drift),
  - `plain` (2 pages of text, no outline),
  - `scanned` (1 page, image XObject only — no text layer).
  Generated in `beforeAll` in CI/local — no binary in the repo.

- **PDF parser** (`apps/api/src/services/pdf/parse-pdf.ts`): pure logic on
  `pdfjs-dist/legacy/build/pdf.mjs` — title/author from the info dict,
  `pageCount`, outline walk with destination→page resolution (→ TOC), and a
  `hasText` probe sampling up to 5 pages (false for scanned files).
  `standardFontDataUrl` points at the package's `standard_fonts/` dir so
  standard-14, non-embedded PDFs extract correct unicode. `PDF_PARSER_VERSION
  = 1` stamped on the doc. Three Node-24 incompatibilities in pdfjs-dist 6.x
  had to be handled (local Node 26 hid them; CI/prod run `node:24-alpine`):
  1. **`WeakMap.prototype.getOrInsertComputed`** — the *regular* build's
     worker transport uses it (Node ≥ 26 only), so `getMetadata()` threw
     `getOrInsertComputed is not a function`. Fix: import the **legacy**
     build (the Node-appropriate one — it also removes pdf.js's
     "Please use the legacy build" warning).
  2. **`Uint8Array.prototype.toHex`** — called in the open() path
     (`hashOriginal.toHex`); native only in Node ≥ 25. `parse-pdf.ts`
     patches it when missing (no-op on newer runtimes).
  3. **standard font data** — without `standardFontDataUrl` the text probe
     warns and under-counts words for non-embedded standard-14 docs.

- **Worker** (`apps/api/src/worker.ts`, `jobs/boss.ts`): new boss job
  `pdf.process`. On claim it reads the **original** file back from the object
  store (the plaintext path — encryption is at the storage boundary), parses,
  writes TOC entries (with resolved `page`), sets `pdfModeAvailable`
  (`"faithful"` — reflow mode is slice 9), `pageCount`, `pdfHasText`,
  `wordCount` (null for scans), and marks the doc `ready`.

- **Documents routes** (`apps/api/src/routes/documents.ts`,
  `documents-slice6.test.ts`):
  - Upload detects PDF by **magic bytes** (`%PDF-`) in addition to the MIME
    type; the original is stored untouched and the doc gets
    `document_type='pdf'`.
  - `GET /v1/documents/:id/original` — returns a **signed asset URL** for the
    original bytes; the asset route serves it with **`Range` support**
    (single- and multi-range), which is what lets pdf.js do byte-range
    loading instead of downloading the whole file.
  - List + detail responses carry `pdfModeAvailable`, `pageCount`,
    `pdfHasText` (null for non-PDF docs; `false` = scan).

- **Shared contracts** (`packages/shared`):
  - `PdfAnchor` (`{kind:"pdf", page, quad, text}`) in `anchors.ts` + zod,
    with `buildPdfAnchor`/`pdfAnchorToTextRange` mapping a quad against the
    shared page-text string — unit-tested alongside the text anchors.
  - `Locator` now accepts a pdf variant (`{kind:"pdf", page, yFrac}`) so
    progress can resume mid-document.
  - `HighlightLocator` extended for the pdf kind; `DocumentMeta` carries
    `pdfModeAvailable`/`pageCount`/`pdfHasText`.
  - Canonical-text rule `pdfPageText` is the single source of truth for both
    the worker's stored text and the web's text layer, so stored anchors and
    rendered layers agree.

- **Web reader** (`apps/web/src/main.tsx`): a `PdfReader` beside the section
  reader —
  - pdf.js 5.x (web + worker via Vite `?worker` import) loading the original
    through the signed-asset range endpoint;
  - **outline → TOC**: the PDF outline is the TOC (clickable page
    destinations, `toc` testids);
  - **progress**: page indicator + position bar; save/restore via the
    pdf locator (0-based page, y-fraction);
  - **text-layer highlights**: an invisible selectable layer over the canvas
    (`position:absolute` over the `position:relative` page box); selection →
    quad extraction → `POST /highlights` with a `PdfAnchor`; stored
    highlights re-render as `<mark>` overlays from their anchor after reload;
  - **scanned PDFs**: `pdfHasText === false` shows a clear
    "no text layer — highlights and reflow are unavailable" message (SPECS
    §2); no OCR, no reflow (slice 9).
  - The two **real bugs local verification caught** before this would have
    shipped: the `<canvas>` had no `ref={canvasRef}` (render effect silently
    bailed → blank white page, invisible to unit tests) and the text layer
    was in normal flow instead of an absolute overlay.

- **Migration 0007** (`drizzle/0007_pdf_faithful.sql` + snapshot):
  `documents.pdf_mode_available`, `documents.page_count`,
  `documents.pdf_has_text`, `toc_entries.page`.

- **e2e** (`e2e/documents.spec.ts`): the PDF flow **piggybacks the spec's
  single login** — a standalone `pdf.spec.ts` with its own login would be the
  5th request-code call, and the rate limiter (5 per 15 min per IP) would
  drop it silently in CI. Covered in the run: upload outline PDF → `ready` →
  reader renders the canvas + "2 pages" → outline has both chapters →
  clicking "Chapter Two" jumps to Page 2/2, prev returns to Page 1/2 →
  select "first chapter begins here" → save → `<mark>` with that text →
  reload → Page 1 restored with the `<mark>` re-rendered → upload scanned
  PDF → `ready` → canvas renders + `pdf-no-text` message + Page 1/1.

## Verified (real output, 2026-11-04)

**CI run `1c41c7d` (github.com, node:24-alpine, fresh postgres + s3mock):
all jobs green — test, images, e2e (Playwright 4/4, incl. the full PDF
path).** This is the authoritative gate: it is the exact runtime where the
Node-24 pdfjs bug lived, and where the render-race fix had to hold.

Local stack (verify): `e2e-postgres-1` + `s3mock` (compose
`docker-compose.local-verify.yml`) + API + worker on 127.0.0.1:3101,
`MAILER=console`, `ALLOWED_EMAIL=e2e@reader.test`.

- Gates: `pnpm build` green; `pnpm -r typecheck` 3/3; `pnpm -r lint` 3/3;
  **242 unit tests green** — 102 shared (incl. 29 pdf anchor/locator cases) +
  140 api (incl. the slice-6 route tests).
- **Live e2e (Playwright, real Chromium): 4/4** — the renamed
  `documents: upload + read book, article, and PDF (faithful)` test covers
  book, article, **and** the full PDF path above in one serial session.
  (Local runs against a long-lived DB can flake on the *book* part —
  repeated runs stack identical fixture books and the spec's `.first()` can
  pick an old doc whose saved progress restores to Chapter One; CI's fresh
  DB does not exhibit this.)
- **Node-24 container repro** (the CI/prod runtime): built `dist/` run in a
  `node:24-alpine` container against the same compose stack + s3mock —
  upload outline PDF → `ready (pdf, 2 pages, 2 outline entries, text layer)`;
  scanned fixture → `textChars=0, outline=null` (probe correctly reports no
  text); no `standardFontDataUrl` / legacy-build warnings.
- Live curl loop (session cookie from the console mailbox):
  - Upload of all three fixture variants → all `ingestState=ready` within
    seconds: outline = 2 pages / 2-entry TOC / `pdfHasText=true`;
    plain = 2 pages / no TOC / `true`; scanned = 1 page / **`pdfHasText=false`**,
    `wordCount=null`.
  - `GET /documents/:id/toc` → the two outline entries with resolved pages;
    `GET /documents/:id/original` → signed asset URL; the asset serves full
    GET and `Range: bytes=0-3` correctly (this is the path pdf.js uses).
- Browser (harness Chromium + Playwright): canvas 856×1108 with 4
  text-layer spans per page — the state that **failed before the canvas
  `ref` fix** (canvas stuck at 300×150, zero spans).
- **Render race (found via CI after the Node-24 fix):** navigating
  page 2 → page 1 left `pdf-text-layer` showing page 2's text. A second
  `page.render()` on the shared canvas while the first was in flight is
  rejected by pdf.js (concurrent render on one canvas), so the newer page
  never painted. Fix: serialize all renders through a `renderChain` promise
  (await previous → bail if superseded; checked before `getPage`, before
  `page.render`, after `getTextContent`); text-layer build split out to
  `buildPdfTextLayer`; chain reset when a new document opens. Verified by
  the green CI e2e above (outline nav + page-1 text selection + reload
  restore all pass).

## How the owner verifies (post-deploy)

1. `curl https://peisetti.duckdns.org/v1/health` → ok (migration 0007 runs in
   the API container entrypoint — no manual step).
2. Log in, **Upload** a real PDF with an outline (e.g. a textbook). The row
   goes `queued…` → `ready`.
3. Open it: the **outline is the TOC** — click an entry to jump. A large PDF
   should open on the first page without downloading the whole file
   (Network tab: `bytes=` range requests to `/v1/assets/...`).
4. **Highlight** a passage, reload → you are back on the same page with the
   highlight still there.
5. Upload a **scanned** PDF (image-only pages) → it opens, and the reader
   shows the clear "no text layer" message instead of highlighting/progress
   affordances.

## Known gaps / follow-ups

- **Node 24 vs local Node 26** (the slice's main gotcha, found via CI): local
  dev runs Node 26, but CI and both prod Dockerfiles run `node:24-alpine`.
  pdfjs-dist 6.x's *regular* build uses `WeakMap.prototype.getOrInsertComputed`
  (Node ≥ 26), so `getDocument(...).getMetadata()` threw
  `getOrInsertComputed is not a function` on Node 24 — the local suite passed
  while CI's e2e failed. Switched the worker to the **legacy** build, which is
  the Node-appropriate variant (and removes pdf.js's own warning). `toHex` and
  `standardFontDataUrl` covered the rest. **Precedent: a runtime that works on
  the dev box can still break CI/prod on a lower Node major** — simulate by
  running the built `dist/` in a `node:24-alpine` container before shipping
  anything that touches a new dependency's runtime APIs.
- **Reflow mode is slice 9** — `pdfModeAvailable` is hard-set to
  `"faithful"`; the shared types already reserve `"both"`.
- Scanned PDFs: no OCR (explicitly out of scope, SPECS §2) — they open and
  are readable as pages, just no text layer.
- pdf.js text-layer quads are computed at the *rendered* scale; anchors store
  normalized (0–1 page-relative) coords, so highlight restore is
  zoom-independent, but very long single-line pages can drift a couple of
  characters in the stored `text` field (anchor resolution is quad-first,
  text is a fallback).
- The e2e PDF coverage lives inside the documents test because of the 4-call
  request-code budget; if the budget grows (e.g. per-IP limiter made
  configurable), split it into a standalone spec.
- `pdfjs-dist` 5.x pulled the same major into `apps/api` (worker parser) and
  `apps/web` (reader) — keep them in lockstep when upgrading (shared
  text-layer/quad geometry).
