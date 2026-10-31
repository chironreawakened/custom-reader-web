# Slice 3 — report (2026-10-31)

Slice 3 scope from PLAN.md: **reader basics** — reading progress
(restore + autosave), reader preferences (theme, font size), nested TOC
rendering, DRM-detection tests, and the handoff-slice-2 carry-over: the
weekly-backup weekday derived in Europe/Helsinki.

## What was built

- **Shared contracts** (`packages/shared/src/`):
  - `progress.ts` — `locator` (discriminated union: `reflow`
    `{sectionId, offset, percent}` / `pdf` `{page, percent}` reserved),
    `progressResponse`, `putProgressBody`, and the pure
    `lastWriteWins(existing, incoming)` decision (SPECS §8).
  - `settings.ts` — `readerTheme` (light/sepia/dark), `readerPrefs`
    (`fontSize` 12–24 px), `DEFAULT_READER_PREFS` (light, 16),
    get/put response schemas (SPECS §11).
  - New `@reader/shared/settings` **subpath export**: the web bundle
    imports `DEFAULT_READER_PREFS`/theme/font-size constants from there,
    not from the barrel (the barrel re-exports node-only `rdr1`/
    `asset-url` crypto — barrel import fails `vite build`).
  - `TocEntryDto` exported from the barrel for the nested TOC tree.
- **Migration `0004_polite_darwin`** (drizzle-generated, unmodified):
  - `app.reading_progress` (`user_id` + `document_id` PK, `locator`
    jsonb, `updated_at` timestamptz; cascade FKs to users/documents).
  - `app.user_settings` (`user_id` PK, `openai_key_enc`,
    `openai_key_last4`, `key_version`, `tts_model`, `tts_voice`,
    `reader_prefs` jsonb). TTS/OpenAI-key columns exist per the SPECS §5
    schema but get their routes in later slices.
- **Progress + settings API** (`routes/progress-settings.ts`):
  - `GET /v1/progress/:documentId` — stored locator or nulls.
  - `PUT /v1/progress/:documentId` — client carries its own
    `updatedAt`; **last write wins** (SPECS §8): newer-or-equal wins, a
    stale client gets `409 conflict` (not a silent rollback).
  - `GET /v1/settings` — stored prefs or defaults when no row.
  - `PUT /v1/settings` — upsert of `readerPrefs` only.
  - All four require session auth; cookie-authed mutations are
    CSRF-checked (bearer-only exempt, same rule as slice 2).
  - Route tests (`progress-settings.test.ts`): auth 401s, no-CSRF 403,
    nulls → write → 409 stale → newer wins, 400 on bad bodies, settings
    defaults + round-trip.
- **DRM detection tests** (`parse-epub.test.ts`, +6 cases): all four
  detector signals exercised through real fixture injection points —
  (1) `adobe-drm/` file path, (2) `*.drm` file path, (3) `ADEPT` meta
  name in OPF, (4) `key-system` element in OPF; plus "DRM hit yields
  empty epub (sections/TOC/assets never parsed)" and "benign metadata
  (cover, ncx) does NOT trip detection". 16/16 parse-epub tests green.
- **Web reader** (`apps/web/src/main.tsx`, `api.ts`):
  - Progress restore-on-open: opens the saved section and scrolls to the
    saved offset, once per book open (a stale sectionId falls back to
    the first section).
  - Debounced autosave: section change (offset 0) + 500 ms scroll
    debounce; a `409` invalidates the query and picks up the newer spot.
  - `ReaderControls`: theme select (light/sepia/dark) + font size
    A−/A+ (clamped 12–24 px); prefs fetched once, saved on change,
    applied as `data-theme` + content font size.
  - Nested TOC: flat `toc` entries (with `parentId`) rendered as a
    recursive `TocTree`; entries with unknown parents fall back to the
    top level.
- **e2e** (`e2e/progress.spec.ts`): login (console mailbox) → open the
  fixture book (uploaded by `documents.spec.ts`; suite is serial) → jump
  to a chapter via the TOC (autosave stores the locator) → reload →
  reopen → assert it lands on the saved chapter, not the title page;
  then switch theme and assert it survives a reload. Runs after
  `documents.spec.ts` (alphabetical order), which satisfies the
  fixture-upload dependency.
- **Weekly-backup weekday** (handoff carry-over, `jobs/backup-schedule.ts`):
  the worker now picks the backup kind via `backupKindFor()` — weekday
  derived in **Europe/Helsinki** through `Intl.DateTimeFormat` — instead
  of `getUTCDay()`. Verified there is **no real bug** at the current
  `0 3 * * *` cron (03:00 Helsinki fires on the same UTC day), but the
  refactor removes the implicit "cron hour ≥ UTC offset" assumption.
  Unit-tested for EET + EEST (DST) firings.

## Verified (real output, 2026-10-31, local verify stack)

Local stack: postgres:17 + adobe/s3mock + API + worker on 127.0.0.1:3101,
`MAILER=console`; migration 0004 applied before boot.

- Gates: `pnpm build` green; `pnpm -r lint` / `typecheck` 4/4; unit
  tests green (shared +62, api +38 incl. 6 new DRM + 6 backup-schedule).
- Live curl loop: login (code from `/tmp/local-mailbox.log`) → upload
  fixture → worker ingest → TOC; then 10 progress/settings round-trips:
  GET nulls → PUT no-CSRF 403 → PUT 200 → stale PUT 409 → newer PUT 200
  → bad body 400 → settings default → put → get round-trip. All correct.
- Browser (real Chromium, :3101 serving the built web UI): signed in,
  opened the fixture book, **landed on the previously-saved Chapter
  Two**; theme switched live (dark → light) and persisted to the API;
  font size stepped and clamped; nested TOC rendered and navigated.
- Migration shape checked in the local DB (`\d app.reading_progress`,
  `\d app.user_settings` — PKs + cascade FKs as specified).

## How the owner verifies (post-deploy)

1. `curl https://peisetti.duckdns.org/v1/health` → `api/db/storage ok`.
   (Migrations run in the API container entrypoint — no manual step.)
2. Log in at `https://peisetti.duckdns.org/`.
3. Open a book → read into a section → scroll a bit → **reload the
   page** and reopen the book → you should land on the same section and
   scroll position.
4. In the reader header: switch **Theme** (light/sepia/dark) and step
   **Text size** (A−/A+) → the reader restyles live; reload → prefs
   persist.
5. TOC: books with nested TOCs (e.g. a real EPUB with sub-chapters)
   show indented levels; clicking any entry navigates.
6. Upload a DRM-protected EPUB → ingest fails with a DRM error message
   (the doc shows `failed` with the detector reason).
7. Backup: next Monday ~03:00 EET, the worker log shows a `weekly`
   backup object (other days `daily`) — same observable as slice 2.

## Known gaps / follow-ups

- `locator.kind = "pdf"` is in the shared contract but no PDF reading
  mode exists yet (later slice) — the API accepts and stores it.
- `user_settings` TTS/OpenAI-key columns exist but have no routes yet
  (later slices per PLAN.md).
- Progress autosave debounces at 500 ms — closing the tab within that
  window loses the last scroll position (section-level position is
  always saved on navigation).
- `percent` is computed from spine index, not content length — a rough
  document-position estimate, sufficient for single-device restore.
- No delete-document route yet (storage/progress rows would leak) —
  later slice per PLAN.md.

## Deviations

- None. The upload route path and signed-asset design from slice 2 are
  unchanged; slice 3 uses the existing `GET /v1/documents/:id/toc`
  response (extended with `parentId` on `TocEntryDto`) rather than a
  new nested-TOC endpoint.
