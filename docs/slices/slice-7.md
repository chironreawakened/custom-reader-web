# Slice 7 — TTS (text-to-speech reading)

Status: **done** (local gates green 2026-11-11; e2e verified by CI)

## What shipped

Read-aloud for both readers: a TTS toggle in the reader toolbar drives a
per-chunk speech pipeline — OpenAI `speech` synthesis (chunked), signed
`/v1/tts-audio` MP3 delivery, cache-first playback, and sentence-level
highlighting of the currently spoken chunk.

- `packages/shared/src/tts.ts` (+ tests): chunker (block-split, ≤ 480-char
  chunks, heading/paragraph ordering) and voice list.
- `apps/api/src/services/tts.ts`: job → OpenAI speech → S3 MP3 → signed URL;
  per-(document, chunk) cache in the DB (`tts_cache` table, migration
  `0008_sweet_morlun`).
- `apps/api/src/services/openai-key.ts`: per-user key storage +
  `looksLikeOpenAiKey` shape validation.
- `apps/api/src/routes/tts.ts` (+ tests): `POST /v1/tts` (409
  `no_openai_key` when the user hasn't stored a key), `GET /v1/tts-audio`
  (signed URL only, no MP3 bytes through the API), `PUT/GET/DELETE`
  `/v1/tts/key`.
- `apps/api/src/worker.ts` + `jobs/boss.ts`: `JOB_TTS_CHUNK` — the worker
  performs the OpenAI call with `OPENAI_API_BASE_URL` (CI: loopback mock).
- Web: TTS panel in the reader toolbar (`main.tsx`) — chunk list, prev/next,
  stop, `tts-mark` sentence highlight, no-key error with Settings link;
  Settings modal gains key field + voice select (`13` shared voices).
- `e2e/openai-server.ts` + `e2e/tools/openai-mock.mjs`: loopback mock of the
  OpenAI speech endpoint with a request counter; started in-spec (idempotent).
- `e2e/tts.spec.ts`: no-key 409 → save key → synthesize chunk 1 (heading) →
  step to chunk 2 (first paragraph, sentence highlight) → stop + re-enable
  replays from cache with the mock counter frozen at 2.
- CI (`ci.yml`): `OPENAI_*` / `AUTH_REQCODE` env for the e2e job (mock base
  URL is injected by the spec itself; the worker picks it up via
  `OPENAI_API_BASE_URL`).

## Verification

- Local (2026-11-11): `pnpm -r lint` clean; `pnpm -r typecheck` clean;
  `pnpm -r test` 56/56 (shared 21, api 35, web 0 — no web unit tests).
  Spec typechecked standalone against the installed `@playwright/test` +
  `@types/node`.
- e2e: runs in CI only (VPS 4 GB RAM — AGENTS.md). Playwright job includes
  the new `tts.spec.ts` automatically (glob `e2e/*.spec.ts`), serial after
  `documents`/`progress` so the fixture book + saved position exist.

## Notes / pitfalls

- The e2e fake key must match `looksLikeOpenAiKey`
  (`^sk-(proj-)?[A-Za-z0-9_-]{16,}$`) or the API rejects it with 400 before
  storage; it is a synthetic fixture, not a credential.
- Chapter One chunk layout: heading = chunk 1 (not prose); 3 chunks total
  (heading + 2 paragraphs). `<img>` contributes no text.
- `progress.spec` leaves this book's saved position at Chapter One; the TTS
  spec relies on reader restore and falls back to the TOC.
- Re-enabling TTS after a stop replays the SAME signed URL — Chromium may
  serve it from disk cache with no network response, so the spec asserts
  cache behavior via the mock request counter, not a second audio response.
- `page.request.networkLog()` does not exist in Playwright 1.64; use a
  `page.on("response")` listener with `headerValue("content-type")`.
