# Personal Reader — Exact Specifications

These are binding. Implement them exactly; do not redesign. If something here is wrong or impossible, stop and ask the owner (see AGENTS.md).

## 1. Key derivation

- `APP_MASTER_KEY`: 32 random bytes, base64 in env. Reject startup if it doesn't decode to exactly 32 bytes.
- Subkeys: `HKDF-SHA256(ikm = APP_MASTER_KEY, salt = "personal-reader/v1" (UTF-8), info = <label>, length = 32)` (Node `crypto.hkdfSync`).

| Label | Use |
|---|---|
| `storage-kek/v1` | wraps per-object data keys |
| `asset-url/v1` | HMAC for signed asset URLs |
| `api-key-enc/v1` | encrypts the stored OpenAI key |
| `otp-hmac/v1` | HMAC of login codes |

- Every wrapped key / ciphertext in the DB stores a `key_version` int (starts at 1) so the master key can be rotated later by re-wrapping.

## 2. Encrypted object format (`RDR1`)

Used for every object written to Hippius (originals, section HTML, images, covers, TTS audio, DB backups).

### Data key
- Random 32-byte DEK per object. Never reused.
- Wrapped with AES-256-GCM using the `storage-kek/v1` subkey, random 12-byte nonce, AAD = UTF-8 `"rdr-dek/v1|" + object_id`.
- Stored in `storage_objects.wrapped_dek` as `nonce(12) || ciphertext(32) || tag(16)` = 60 bytes.

### Ciphertext layout
STREAM construction (online AEAD, segment-wise), AES-256-GCM with the DEK.

```
header (16 bytes, plaintext):
  magic         4 bytes  "RDR1"
  version       1 byte   0x01
  segment_size  4 bytes  big-endian uint32 = 65536
  nonce_prefix  7 bytes  random
segments:
  segment i = GCM ciphertext of plaintext[i*S .. min((i+1)*S, size)) || tag(16)
```

- `S = 65536`. All segments except the last are exactly `S` plaintext bytes. The last is `0..S` bytes.
- Number of segments `n = max(1, ceil(size / S))`. An empty plaintext is one empty last segment.
- Nonce for segment `i` (12 bytes): `nonce_prefix(7) || uint32_be(i)(4) || last_flag(1)`, where `last_flag = 0x01` for segment `n-1`, else `0x00`.
- AAD for every segment = the 16-byte header.
- Ciphertext offset of segment `i` = `16 + i * (S + 16)`.
- `storage_objects.plain_size` stores the plaintext size (needed to know `n` and the last segment).
- **Decryption must fail** (and never return partial plaintext as valid) on: wrong magic/version, any tag failure, a missing final segment (truncation), extra trailing bytes, reordered segments.

### Range reads
Plaintext range `[a, b]` → segments `floor(a/S) .. floor(b/S)` → fetch that ciphertext byte range from storage → decrypt each segment → slice. The API's `/v1/assets/:id` serves HTTP `Range` this way.

- **Must be verified in slice 0**: whether Hippius supports S3 ranged GETs. If not, stop and ask the owner. (Contingency: a local on-disk ciphertext cache, size-capped.)

### Required tests
Round trip at sizes `0, 1, S-1, S, S+1, 3S, 3S+7`; every range-read boundary case; tamper (flip a bit in the header and in each segment); truncation (drop the last segment, drop bytes); reordering (swap two segments); wrong DEK. Plus **frozen test vectors**: a fixed DEK, nonce prefix and plaintext, with the expected ciphertext committed as a hex fixture, so the format can never change silently.

## 3. Signed asset URLs

- URL: `/v1/assets/<asset_id>?exp=<unix_seconds>&sig=<base64url>`.
- `sig = HMAC-SHA256(asset-url/v1, "v1|" + asset_id + "|" + user_id + "|" + exp)`. Compare in constant time.
- `exp` = end of the current 6-hour window + 6 hours (`(floor(now / 21600) + 2) * 21600`). URLs are stable within a window for caching and live 6–12 h.
- The endpoint requires no cookie/bearer. It verifies the signature and expiry and that the asset belongs to `user_id`, then streams decrypted content with `Content-Type` from the DB, `Cache-Control: private, max-age=<seconds until exp>`, `Accept-Ranges: bytes`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.
- In stored section HTML, images are `src="asset:<asset_id>"` (no srcset). The section endpoint rewrites these to signed URLs at response time.

## 4. Login codes and sessions

- Code: 6 random digits (`crypto.randomInt`). Stored as `HMAC-SHA256(otp-hmac/v1, user_id + "|" + code)`.
- Expiry 10 min; single use; `attempts` incremented on every wrong guess; invalid after 5. Requesting a new code invalidates older ones.
- Rate limits: request-code 5 per 15 min per IP and 5 per hour per email; verify-code 20 per 15 min per IP.
- Responses never reveal whether an email is allowed.
- Session token: 32 random bytes, base64url. Store `SHA-256(token)` only. Cookie `rdr_session`: HttpOnly, Secure, SameSite=Lax, Path=/, 30-day sliding expiry. Bearer tokens (RN) use the same table with `kind = 'bearer'`, 90 days.
- CSRF for cookie auth: mutating requests must include header `X-Requested-With: reader` and pass an `Origin` check against the configured public origin. Bearer requests are exempt.

## 5. OpenAI key storage
AES-256-GCM, `api-key-enc/v1` subkey, random 12-byte nonce, AAD = `"openai-key|" + user_id`. Store `nonce || ct || tag` plus `last4` for display. The key is never returned by the API.

## 6. Canonical text (shared by web and RN)

Implemented once in `packages/shared`, pure TS, working on a minimal DOM interface so it runs in browsers, jsdom/linkedom (server) and RN.

`canonicalText(root) → { text: string, map }`:
1. Walk the DOM in document order.
2. Ignore the contents of `script, style, rt, rp, template` and of elements marked `data-rdr-ignore`. Images contribute nothing (no alt text).
3. Block boundaries: `p, h1–h6, li, blockquote, pre, div, section, article, header, footer, aside, figure, figcaption, table, tr, td, th, dt, dd, ul, ol, dl, hr, br` start and end a block. Between blocks, emit exactly one `\n`. Never emit leading/trailing `\n` and never two in a row.
4. Inside `pre`: keep text as-is (convert `\r\n` to `\n`).
5. Elsewhere: convert NBSP (U+00A0) and all Unicode whitespace to space, collapse runs to one space, and trim spaces adjacent to block boundaries.
6. Apply Unicode NFC to the result. The `map` must stay correct after normalization (normalize text node by text node, before collapsing).
7. Offsets are UTF-16 code units (JS string indices).
8. `map` converts both ways: canonical offset ↔ (text node, offset in node).

Golden-file tests: fixture HTML → expected canonical text, committed. Any change to canonical text bumps `CANONICAL_TEXT_VERSION` (stored on highlights).

## 7. Highlight anchors

```ts
type ReflowAnchor = {
  kind: 'reflow'; v: 1;
  sectionId: string;
  exact: string;          // canonical text of the selection
  prefix: string;         // up to 32 chars before, canonical text
  suffix: string;         // up to 32 chars after
  offsetHint: number;     // start offset in canonical text
  canonicalTextVersion: number;
};
type PdfAnchor = {
  kind: 'pdf'; v: 1;
  page: number;           // 1-based
  exact: string; prefix: string; suffix: string;
  offsetHint: number;     // offset in that page's text-layer string
};
```

Resolution, in order:
1. `exact` found at `offsetHint` with matching prefix/suffix → use it.
2. All occurrences of `exact` → score by prefix match + suffix match − distance from the hint → take the best if it has a positive score.
3. Fuzzy match (diff-match-patch `match_main`, threshold 0.3) around the hint.
4. Otherwise **orphaned**: shown in the highlights list, not in the text. Never dropped.

Highlights may span block boundaries (`exact` then contains `\n`).

## 8. Reading progress locator

```ts
type Locator =
  | { kind: 'reflow'; sectionId: string; offset: number; percent: number }
  | { kind: 'pdf'; page: number; percent: number };
```
`PUT` with a client `updatedAt`. The server keeps the newer value (last write wins).

## 9. Search configuration
- `documents.language` ∈ `english | finnish | simple`.
- `search_vector` of sections and highlights is built with the document's config. Only the `tsvector` is stored for sections. Section plaintext is not stored in Postgres.
- Query: `websearch_to_tsquery('english', q) || websearch_to_tsquery('finnish', q) || websearch_to_tsquery('simple', q)`, ranked with `ts_rank`.
- Truncate section text before vectorizing so it stays under the Postgres tsvector size limit.

## 10. TTS
- Default model `gpt-4o-mini-tts`, voice `alloy`, format `mp3`. Model and voice can be changed in settings. **Check the current OpenAI docs for model names and per-request input limits before implementing.**
- The server builds chunks from the section's canonical text: split on paragraphs (`\n`), and split further on sentence boundaries if a paragraph exceeds `TTS_MAX_CHARS` (default 1500, kept under OpenAI's limit).
- Clients request chunks by `(documentId, sectionId, chunkIndex)`, never with arbitrary text, so the proxy can't be used as a general TTS service.
- Cache key `sha256(TTS_NORMALIZATION_VERSION + "|" + model + "|" + voice + "|" + chunkText)`. Cached audio is stored as `RDR1` objects.

## 11. Database schema (Drizzle, Postgres)

All ids are `uuid` (v7), all times `timestamptz`. Every table except `users` has `user_id` (FK).

- **users**: `id, email (unique, lowercase), created_at`
- **login_codes**: `id, user_id, code_hmac, expires_at, attempts, used_at, request_ip, created_at`
- **sessions**: `id, user_id, token_hash (unique), kind ('web'|'bearer'), user_agent, created_at, last_seen_at, expires_at, revoked_at`
- **storage_objects**: `id (= S3 object key), user_id, wrapped_dek, key_version, plain_size, mime, created_at`
- **documents**: `id, user_id, type ('epub'|'article'|'pdf'), title, author, language, status ('inbox'|'later'|'archive'), source_url, original_object_id, cover_asset_id, parser_version, ingest_state ('pending'|'processing'|'ready'|'failed'), ingest_error, pdf_mode_available ('faithful'|'both'), word_count, created_at, updated_at`
- **sections**: `id, user_id, document_id, idx, title, html_object_id, canonical_length, search_vector (tsvector, GIN)`; unique `(document_id, idx)`
- **toc_entries**: `id, user_id, document_id, parent_id, idx, label, section_id, anchor`
- **assets**: `id, user_id, document_id, object_id, role ('image'|'cover'|'original'), mime, width, height`
- **tags**: `id, user_id, name`; unique `(user_id, lower(name))`
- **document_tags**: `document_id, tag_id` (PK both)
- **highlights**: `id, user_id, document_id, anchor (jsonb), exact, color, note, search_vector, created_at, updated_at, deleted_at`
- **reading_progress**: `user_id, document_id (PK both), locator (jsonb), updated_at`
- **user_settings**: `user_id (PK), openai_key_enc, openai_key_last4, key_version, tts_model, tts_voice, reader_prefs (jsonb)`
- **tts_cache**: `cache_key (PK), user_id, object_id, created_at`
- **backups**: `id, object_id, kind ('daily'|'weekly'), created_at`

pg-boss uses its own schema.

## 12. API (`/v1`, JSON, zod-validated)

Errors are `{ "error": { "code": string, "message": string } }`. Lists are cursor-paginated: `?cursor=&limit=` → `{ items, nextCursor }`.

| Method & path | Notes |
|---|---|
| `GET /health` | db + storage round trip; no auth |
| `POST /auth/request-code` | `{email}` → always 202 |
| `POST /auth/verify-code` | `{email, code, client: 'web'|'bearer'}` → sets cookie, or returns `{token}` |
| `POST /auth/logout` | revokes the current session |
| `GET /me` | |
| `GET /documents` | filters: `status, type, tag, q` |
| `POST /documents/upload` | multipart, streamed, size-capped → `{id}` (ingest_state pending) |
| `POST /documents/url` | `{url}` → `{id}` |
| `GET /documents/:id` | metadata + ingest_state |
| `PATCH /documents/:id` | `status, title, author, language, tagIds` |
| `DELETE /documents/:id` | deletes DB rows and storage objects |
| `POST /documents/:id/reprocess` | |
| `GET /documents/:id/toc` | |
| `GET /documents/:id/sections` | list: id, idx, title, canonical_length |
| `GET /documents/:id/sections/:sid` | `{html}` with signed asset URLs |
| `GET /documents/:id/original` | `{url}` signed URL to the original (pdf.js) |
| `GET /assets/:id?exp&sig` | no session auth; Range support |
| `GET /highlights` | filter `documentId` |
| `POST /highlights` · `PATCH /highlights/:id` · `DELETE /highlights/:id` | delete is soft |
| `GET /export/highlights.md` | optional `documentId` |
| `GET /progress/:documentId` · `PUT /progress/:documentId` | |
| `GET /tags` · `POST /tags` · `DELETE /tags/:id` | |
| `GET /search?q=` | documents, sections (doc + section ref), highlights |
| `GET /settings` · `PUT /settings` | |
| `PUT /settings/openai-key` · `DELETE /settings/openai-key` | |
| `GET /documents/:id/sections/:sid/tts-chunks` | `[{index, startOffset, endOffset}]` |
| `POST /tts` | `{documentId, sectionId, chunkIndex}` → `{url}` signed audio URL |

The OpenAPI spec is generated from the zod schemas (slice 10). The RN client is generated from it.
