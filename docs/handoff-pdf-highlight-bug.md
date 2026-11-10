# Handoff — PDF highlight "text moves" bug (open, P2)

**Owner decision (2026-11-05):** move forward — PDF highlighting is not the
highest-priority feature. This bug is **open but deprioritized**. Slice 6 is
considered complete (core scope shipped, CI green, deployed); this is a
post-deploy rendering defect to pick up when highlighting matters again.

## Symptom (owner-reported, on prod `peisetti.duckdns.org`)

Owner uploaded a real 209-page PDF book (~24 MB, "Hundred Page…" title,
doc id `e3d03743-7b4c-426b-8944-a72518d98a83`, progress page 11/209) and
highlighted a passage. **The visible text changes/moves when the highlight
is applied, and changes back when it is removed.** Owner says the residual
behavior is "still pretty bad" even after the 2026-11-05 fix (`5d2fe56`).

## Already fixed + ruled out (do not re-diagnose)

Commit `5d2fe56` (deployed) fixed three real defects in `apps/web/src/main.tsx`:

1. `<mark>` got the UA-default **black text** (text-layer spans are
   `color: transparent`, the canvas is the ink) → highlighted words turned
   opaque. Fixed: `mark.style.color = "transparent"` in `placePdfMarks`.
   **Verified** (computed style + e2e assertion). Not the owner's symptom.
2. The highlights effect only ever *added* marks → color change double-wrapped
   (nested `<mark>`), delete left stale marks. Fixed: full reconciliation
   (unwrap previous marks + `normalize()`). **Verified** (delete → 0 marks).
3. "Cancel" on the pending-selection bar left the browser selection on screen.
   Fixed in both readers.

e2e now asserts all three (`e2e/documents.spec.ts`, green in CI on a fresh DB).

## What is NOT yet explained

The owner still sees text moving when highlighting. Ruled out by inspection:
the text-layer spans are `position:absolute` + `white-space:pre`, so wrapping
a text node in `<mark>` **cannot reflow sibling content** — a pure layout-
reflow explanation is unlikely.

## Leading hypothesis (untested)

**The text layer does not align with the canvas ink, and the highlight band
exposes the misalignment.** `buildPdfTextLayer` (main.tsx ~1482) positions
spans with hand-rolled math: font is hardcoded `sans-serif` (the document's
real font is not used), and the baseline uses an **ascent ratio of 0.8**
approximation. For a book with distinctive fonts/metrics the layer's words
sit at slightly different x/y than the ink. Invisible at rest (spans are
transparent), but the highlight's **background band** is painted at the
*layer's* position — offset from the actual glyphs → "the text changes";
removing the band → "changes back". This matches the symptom's symmetry.

Secondary candidate: owner's mid-book page 11/209 also showed a separate
**intermittent stall** (canvas painted, text layer empty, no error, no
spinner) during repro — possibly a stalled `renderChain` link or an unhandled
`getTextContent()` rejection. Worth a look while in this code, but distinct.

## Suggested approach for the next agent

1. **Get a minimal repro.** The hand-made fixture
   (`apps/api/tools/make-fixture-pdf.mjs`, default fonts) did **not**
   reproduce the movement — the bug likely needs a real embedded font.
   Ask the owner for a *small* PDF (a few pages, real fonts) from the same
   book, or any book-like PDF that moves on highlight.
2. **Measure, don't eyeball.** On highlight: record
   `getBoundingClientRect()` of every span before/after `placePdfMarks`
   (proves/disproves movement of the layer itself), and diff
   canvas-pixel screenshots of the marked region before/after (proves
   whether the *band* is offset from the ink).
3. **If the band is offset from the ink** (leading hypothesis): the robust
   fix is to draw highlights as **absolutely-positioned overlay rectangles
   from the stored quads/anchor geometry** (shared anchor types are
   quad-first; `resolvePdfAnchor` in `packages/shared/src/anchors.ts`),
   decoupled from the text layer's layout entirely. Alternatively make the
   text layer metric-accurate (real font via pdf.js `page.getFont` +
   font-face, real ascent from the font metrics) — larger change, and the
   overlay approach also fixes any future font drift.
4. **Repro env:** local verify stack (see below). The 24 MB book OOMs the
   headless browser on this 3.8 GB VPS — do repros with a small PDF.

## Environment / operational notes

- Repo `~/projects/custom-reader-web`, branch `main` (head: `69acff1`).
  pnpm: `~/.local/bin/pnpm` (v10). Local Node is **26**; CI + prod images
  are **node:24-alpine** — CI (fresh postgres) is the authoritative gate.
- Local verify stack: `e2e/e2e-postgres-1` (127.0.0.1:54329) + `s3mock`
  (:9000) via `e2e/docker-compose.local-verify.yml`, API+worker run as plain
  node from `apps/api/dist` on :3101 with `e2e/.local-verify.env`
  (`ALLOWED_EMAIL=e2e@reader.test`, `CONSOLE_MAILBOX=/tmp/local-mailbox.log`).
  **Port 3101 is public — must not stay running.** Login rate limit:
  5 codes/15 min per IP, in-memory (API restart resets). Local DB is
  polluted with duplicate fixture docs — expect e2e book-section flakes
  locally (documented in slice-6.md); CI fresh-DB does not flake.
- Prod: `/srv/reader/`, `.env` `TAG=5d2fe567012d39f239e8a5a7a8dfe33f77765de6`,
  deploy via `sudo /srv/reader/deploy.sh <full-sha>`. Break-glass login for
  owner testing: `sudo docker compose -f /srv/reader/docker-compose.yml
  exec -T api node dist/cli.js login-code` (mint code for
  vm.tikkanen@gmail.com — deliver via the owner's chat, never log it).
- The remote `slice-6` tag still points at `c8ebbbc` (pre-fix); owner has
  not consented to force-move it. CI/deploy key off the SHA, so it's
  cosmetic.
- Scratch scripts in `tmp/` (`verify-fix.mjs`, `tight-mark.mjs`, etc.) are
  uncommitted by design — usable as starting points, not canon.

## Relevant code map

- `apps/web/src/main.tsx` — `PdfReader` (~1560): `buildPdfTextLayer` (~1482),
  `placePdfMarks` (~1430, `PdfPlacedMark` shape), render effect with
  `renderChain`/`renderSeq` (~1683), highlights reconciliation effect
  (~1735), `onMouseUp` selection→save bar (~1758).
- `packages/shared/src/anchors.ts` — `buildPdfAnchor`, quad-first anchor
  resolution.
- `e2e/documents.spec.ts` — the PDF e2e path incl. the new highlight
  assertions (create/color/delete).
- `docs/slices/slice-6.md` — slice record, both earlier root causes, local
  flake note.
