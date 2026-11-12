# Slice 8 — Full-text search

Status: **done** (local gates green + live-verified 2026-11-12; e2e runs in CI).

## What shipped

Postgres full-text search over a user's own corpus (SPECS §9, §12). Each
document is indexed with **its own** FTS config (the detected language,
`english` | `finnish` | `simple`), and a query is matched against all three
configs OR'd together, so a term resolves in whichever config actually
indexed the hit. `GET /v1/search?q=` returns three independently-ranked
lists (documents, sections, highlights), each ranked by `ts_rank` and capped.

- `packages/shared/src/search.ts` (+ `index.ts` export): the search contract —
  `searchQuery` (`q`, 1..500 websearch chars), the three hit schemas
  (`searchDocumentHit`, `searchSectionHit`, `searchHighlightHit`),
  `searchResponse`, and the `SEARCH_MAX_Q` / `SEARCH_MAX_PER_LIST` (=25) caps.
- `apps/api/src/db/search-vector.ts`: `searchVectorSql(language, text)` —
  the single builder used by **both** the worker (sections) and the
  highlights route. Truncates to `SEARCH_VECTOR_MAX_CHARS` (100,000) before
  vectorizing (a tsvector column is hard-capped at 1,048,575 bytes; 100k
  source chars keeps even an all-distinct-token section ≈ 250k bytes, 3×
  under). Config is passed as a bound parameter, `null` → `simple`.
- `apps/api/src/worker.ts`: EPUB + article section inserts now call
  `searchVectorSql(<doc language>, canonicalText)` (was a hard-coded
  `to_tsvector('simple', …)`). PDFs create no sections, so PDFs are indexed
  only via their highlights.
- `apps/api/src/routes/highlights.ts`: the highlight `search_vector` is built
  with the **document's** language config over the highlight's `exact` text.
- `apps/api/src/routes/search.ts` (+ `search.test.ts`, 9 tests):
  `GET /v1/search?q=`. Session auth only (read-only GET, no CSRF). The query
  is one combined, OR'd tsquery —
  `(websearch_to_tsquery('english',q) || websearch_to_tsquery('finnish',q) ||
  websearch_to_tsquery('simple',q))::tsquery` — built as a **single bound
  parameter** (never interpolated). Three queries: sections (ranked by
  `ts_rank`), documents (ranked by `max(ts_rank)` over their sections),
  highlights (ranked by `ts_rank`), each `@@ combined`, each capped at 25.
- `apps/api/src/server.ts`: registers `registerSearch` (between tags and tts).
- `apps/web/src/api.ts`: `search(q)` client method.
- `apps/web/src/main.tsx`: a search form in the Library (type + **Search
  button** — submit-triggered, not per-keystroke), the `SearchResults` panel
  (documents / sections / highlights, each a deep-link row), and section
  deep-linking: a section (or PDF-anchored highlight) hit opens its document
  **at that section** via a new `initialSectionId` threaded
  `SignedIn → OpenDocView → Reader`. PDFs have no sections, so they open at
  page 1.
- `apps/api/tools/make-fixture-epub.mjs`: parameterized by `FIXTURE_LANG` —
  `fi` produces a Finnish book ("Yökirja") whose only matchable words are
  inflected Finnish, so the e2e can prove the finnish stemmer ran. The default
  English book is byte-for-byte unchanged.
- `e2e/search.spec.ts` (serial; one login): uploads an English + a Finnish
  fixture book, then asserts (1) `foxes` hits the English book and not
  Finnish, (2) `kissat` hits the Finnish book even though its text is
  "kissa" (kissa/kissat → stem `kis`), (3) nonsense → zero results, (4) a
  section deep-link opens the book at the matching chapter, (5) a saved
  highlight's text surfaces in the highlights list.

## Verification

- Local (2026-11-12): `pnpm -r typecheck` clean; `pnpm -r lint` clean;
  `pnpm -r test` **283 passed** (shared 114, api 169 — incl. the 9 new
  `search.test.ts` route tests).
- Live (curl + browser against the local-verify stack, real Postgres 17):
  uploaded a Finnish fixture, worker indexed its sections finnish-config
  (`'kis' 'istu' 'nukkuv'…`); `q=kissat` → the Finnish book (doc + section,
  rank ≈ 0.038), `q=foxes` → the English book (rank 0.0304),
  `q=zzqxwvzz` → empty, and a saved "kissa nukkuu" highlight surfaced in the
  highlights list. Browser: the Library search box returns "3 results for
  kissat" and clicking the section hit opens Yökirja at "Luku Yksi".
- e2e: runs in CI only (VPS 4 GB RAM). The Playwright job picks up the new
  `search.spec.ts` via the `e2e/*.spec.ts` glob, serial with the other specs.

## Notes / pitfalls

- **The combined tsquery MUST be parenthesized before the cast.**
  `websearch_to_tsquery('english',q) || … || websearch_to_tsquery('simple',q)::tsquery`
  casts only the *last* term (cast binds tighter than `||`), so the match
  clause becomes `tsvector @@ (tsquery || text)` → `operator does not exist:
  boolean || tsquery` → 500. Wrap the whole OR in `(...)` and cast once. This
  is the single most likely regression if the fragment is ever rewritten; it
  only 500s on a real Postgres (the unit-test fake never compiles the SQL).
- The secondary document-title lookup uses drizzle `inArray(documents.id, ids)`,
  **not** raw `sql`…`= ANY(${ids})` — the latter binds the JS array as a
  single scalar parameter (`id = ANY($1)`) and 500s. `inArray` expands to a
  proper `IN (…)` list.
- Drizzle `sql` fragments are opaque — `String(frag)` and `queryChunks`
  don't serialize to the final SQL text, so asserting on the exact SQL string
  in a unit test is brittle. `search.test.ts` asserts the *shape* (three
  `websearch_to_tsquery('…', q)` clauses + an `@@` match) via a chunk
  flattener, not the full string.
- `websearch_to_tsquery` never throws on malformed input (an unbalanced quote
  yields an empty tsquery that matches nothing), so no input guard is needed
  beyond the length cap.
- **PDFs have no sections** — the worker's PDF path creates no `sections`
  rows, so a PDF never appears in the documents/sections result lists (only
  via its highlights). Inherent to storing the vector on sections; documented
  here as the one limitation.
- The e2e asserts **existence** (`.first().toBeVisible()`), never an exact
  count of the shared "Night Fixture Book" fixture — specs share one user +
  one DB in the serial run, and earlier specs have already uploaded their own
  copy, so a "foxes" search can surface several English doc/section hits.
