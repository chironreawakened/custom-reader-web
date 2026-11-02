# Slice 4 — report (2026-11-02)

Slice 4 scope from `docs/handoff-slice-3.md` / PLAN.md: **highlights** —
select text in the reflow reader, save it as a highlight (with optional
colour + note), see it re-rendered as `<mark>` on reload, manage it in a
highlights panel, and export all highlights of a book as Markdown.

## What was built

- **Shared contracts** (`packages/shared/src/`):
  - `canonical-text.ts` — the single canonical-text source of truth shared
    by server and web: `canonicalText(root)` (normalised text with
    block-separator `"\n"` between block-level nodes, text-node
    boundaries recorded), `CanonicalMap` (`toCanonical` / `toNode`) to
    convert between canonical offsets and DOM points, and
    `CanonicalSelection`. Both sides of the reflow anchor resolve through
    this, so a selection made in the browser and a range stored by the API
    can never drift apart.
  - `anchors.ts` — `buildReflowAnchor(selection)` (exact + fuzzy anchor:
    the verbatim selection string plus ±30-char context on each side),
    `resolveAnchor(anchor, canonical)` (exact match first, then a
    `diff-match-patch` `match_main` fuzzy search with
    `Match_Threshold = FUZZY_THRESHOLD`, `Match_Distance = 10_000`), and
    `HIGHLIGHT_COLORS` (yellow/green/blue/pink, 4-entry) +
    `formatHighlightMarkdown(...)` for the export.
  - `highlights.ts` — zod contracts: `postHighlightBody` (anchor + exact +
    nullable colour/note), `patchHighlightBody` (strict; `color`/`note`
    `.nullable().optional()` — omitted = unchanged, `null` = cleared;
    note `max(5_000)`), `highlightDto`.
  - New subpath exports `./anchors`, `./canonical-text`, `./highlights`
    (the web imports only via subpaths — the barrel pulls node-only
    `rdr1`/`asset-url` crypto and fails `vite build`).
- **Migration `0005_yellow_prism`** (drizzle-generated, unmodified):
  `app.highlights` (`user_id` + `document_id` FKs, `section_id`, `anchor`
  jsonb, `color` text, `note` text, `created_at`/`updated_at`,
  `deleted_at` timestamptz soft-delete).
- **Highlights API** (`routes/highlights.ts`):
  - `GET /v1/documents/:id/highlights` — the user's non-deleted
    highlights, each re-resolved against the current canonical text of
    its section; a range that no longer resolves (re-ingest changed the
    text past the fuzzy window) is flagged `orphaned` (the anchor stays
    stored, nothing errors).
  - `POST /v1/documents/:id/highlights` — persist a selection (server
    re-resolves it before storing, so a range that doesn't land is a 422,
    not a broken row).
  - `PATCH /v1/highlights/:id` — colour/note update (PATCH semantics:
    omitted = unchanged, `null` = clear).
  - `DELETE /v1/highlights/:id` — soft delete.
  - `GET /v1/documents/:id/highlights/export.md` — `text/markdown`
    download of all highlights (`> "quoted text" — Section Title` +
    optional note line, colour-labelled when set).
  - `sectionCanonicalTexts(docId, userId, sectionIds)` returns
    `undefined` for a section whose HTML is unavailable (orphan-safe:
    orphaned, never 500).
  - Route tests (`highlights.test.ts`, 23 cases): auth 401s, no-CSRF 403,
    create → list → patch → soft-delete round-trip, orphan flagging,
    422 on unresolvable selection, export body + headers, patch
    omitted-vs-null semantics.
- **Web reader** (`apps/web/src/main.tsx`, `api.ts`):
  - Selection → floating save bar: select text across one or two
    paragraphs, a bar appears with the 80-char preview + a colour
    picker + save. The selection is canonicalised with the shared
    `canonicalText`/`CanonicalMap` (same functions the server uses —
    `defaultCanonicalize` on the API wraps the stored body fragment in
    `<body>` first; the web runs it on the rendered `<article>`), so the
    stored anchor is byte-identical to what the server expects.
  - `applyHighlights`: on section render, each stored highlight is
    resolved against the section's canonical text and drawn as
    `<mark data-testid="hl-mark">` — **including cross-paragraph
    ranges**: `placeRanges` maps each range's start/end canonical
    offsets to DOM points (`pointAtCanonical`/`pointToCanonical` built
    on the shared `CanonicalMap`), splitting the range at block
    boundaries instead of `surroundContents` (which throws across
    blocks). Separator snapping prefers the node *before* a separator
    (a selection ending just after a block break maps to the previous
    block's end).
  - `HighlightsPanel`: lists the book's highlights (section title,
    quoted text, orphaned flag), inline colour change (4 buttons),
    note editing (Enter commits), delete, and a **`.md` export**
    button (opens `export.md` in a new tab).
  - `api.ts`: `getHighlights` / `postHighlight` / `patchHighlight` /
    `deleteHighlight` + `exportHighlightsUrl`.
- **e2e** (`e2e/progress.spec.ts`, extended — no new spec, no extra
  login; the suite stays at 4 request-code calls per run): after the
  slice-3 progress assertions, the same logged-in context opens the
  fixture book, selects cross-paragraph text, saves a highlight, asserts
  the `<mark>` renders in **both** covered paragraphs, reloads and
  asserts it persists, opens the highlights panel, recolors it green
  (`getComputedStyle` backgroundColor — `toHaveStyle` is not in this
  Playwright version), adds a note (Enter commits), and deletes it
  (mark gone).

## Verified (real output, 2026-11-02)

- Gates: `pnpm build` green; `pnpm -r test` green (shared 94 + api 82 =
  176 passing, incl. 23 new highlight route tests + 94 anchors/canonical
  tests); `pnpm -r lint` green; web `pnpm typecheck` clean.
- Migration `0005` applied cleanly on the local verify stack (postgres
  on 54329) before API boot; API + worker up, `/v1/health` 200.
- e2e per the standing rule runs in **CI only** (fresh Postgres + s3mock
  per run, never on this VPS). The spec is transpile-verified
  (`playwright test --list`) and every exact-string assertion was
  re-derived from the fixture source (the 80-char save preview spans
  into paragraph 2's first 6 chars; the mark texts are the exact
  covered-paragraph substrings).
- CI (run for commit `1925bdd`): test + e2e + images jobs — see final
  line below. *(fill in once the run is green.)*

## How the owner verifies (post-deploy)

1. `curl https://peisetti.duckdns.org/v1/health` → `api/db/storage ok`
   (migration 0005 runs in the API container entrypoint).
2. Log in at `https://peisetti.duckdns.org/`, open a book.
3. Select a passage that crosses a paragraph break → the save bar
   appears → pick a colour → save. The passage is highlighted.
4. Reload the page, reopen the book → the highlight is still there.
5. Header **Highlights** → the panel lists it (section + quote); change
   its colour, add a note (Enter saves), delete it → the mark
   disappears.
6. **Export** in the panel → a `.md` download: each highlight as
   `> "quoted text" — Section Title` with the note under it.

## Post-deploy incident: long-anchor crash (fixed `1f7894e`)

Found during post-deploy live verification (2026-11-02) against real
content — a 62,778-char section with a 109-char anchor:

- **Symptom:** `GET /v1/highlights` and `GET /v1/export/highlights.md`
  returned **500** `Pattern too long for this browser.`. The same throw
  would have crashed the web reader's `placeRanges` (it calls the same
  `resolveAnchor`).
- **Root cause:** `resolveAnchor` step 3 (fuzzy) calls
  diff-match-patch `match_main` → `match_bitap_`, which **throws** for
  patterns longer than its `Match_MaxBits` (32). Any long highlight whose
  anchor misses the literal ladder (steps 1–2) hit it. CI was green
  because every fixture uses short text and ≤24-char phrases — the
  boundary was never crossed.
- **Fix:** `fuzzyFind` skips the fuzzy step for patterns > 32 chars
  (`FUZZY_MAX_PATTERN`); they resolve via the literal ladder or flag as
  orphaned (shown in the list, never dropped — the safe direction).
- **Regression tests:** 2 in `packages/shared/src/anchors.test.ts`
  (long orphaned anchor doesn't throw; long resolvable anchor still
  resolves) + 2 at the route level (list + export no longer 500). The
  throw-reproduction was verified by temporarily reverting the guard.
- **Deploy:** redeployed at `1f7894e`; `slice-4` tag moved to the new
  final commit. No data loss: the one test highlight row created during
  the incident was soft-deleted.

## Known gaps / follow-ups

- Highlight editing is colour/note only — the range itself can't be
  re-drawn or extended (reselect and save a new one).
- Fuzzy resolve covers small reflows (a few words changed) but a full
  section re-ingest with substantially different text orphans the
  highlight (flagged, anchor preserved).
- No highlight search/keyboard navigation; the panel is a plain list.
- Notes are capped at 5 000 chars (zod contract); colour is one of the
  four fixed swatches.
- e2e covers the happy path + persistence + delete; orphan and 422 paths
  are unit-tested at the route level, not in the browser.

## Deviations

- No new e2e spec file: the highlights flow was folded into
  `progress.spec.ts` (login budget: 4 request-code calls per CI run,
  codes single-use, suite serial — a 5th login would hit the
  5/15-min IP limiter).
- `placeRanges` does not use `Range.surroundContents` (it throws when a
  range crosses block boundaries; the `extractContents` fallback would
  have collapsed the second paragraph into the first). Cross-paragraph
  ranges are split per block via canonical-offset → DOM-point mapping.

## CI e2e notes

The first two pushes each failed the CI **e2e** job (test + images were
green both times); both were real bugs the unit gates cannot see:

**Fix 1 — e2e spec, `Range` offsets must be node-relative (commit
`0c58737`).** The spec's text-selection helper returned a cumulative
offset across all text nodes (`start + i`), but `Range.setStart`/`setEnd`
take an offset **relative to the given node** — `setEnd` threw
`IndexSizeError: offset 141 > node length 53`. The helper now returns
the in-node `indexOf` result.

**Fix 2 — web `placeRanges`, wrong slice wrapped (commit 3).** After
`node.splitText(from)`, the code wrapped `node` itself — but `splitText`
**mutates** `node` in place to the `[0, from)` prefix and **returns the
remainder**. The wrapped slice was therefore the prefix before the
highlight (`"The "`), and the actual covered text was left unmarked.
The carve-out now uses the returned remainder and rebases `to` onto its
local coordinates. Visible symptom: CI asserted the first mark's text
and got `The ` instead of the covered paragraph text.

**Final state:** CI run 41407690578 (commit `9a7719d`) fully green —
test ✓, images ✓, e2e ✓ (4/4 in 17.9 s, incl. the cross-paragraph
highlight flow).
