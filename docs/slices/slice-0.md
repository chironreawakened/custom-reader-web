# Slice 0 — Walking skeleton

Status: complete locally; CI green on final commit; tagged `slice-0`.
**Owner code review is required before deploying this slice** (AGENTS.md).

## What was built

- **Monorepo** (pnpm 10, Node 24): `packages/shared` (zod + RDR1 crypto),
  `apps/api` (Fastify + worker, Drizzle + pg-boss), `apps/web` (Vite + React SPA).
  `tsconfig.base.json` with `strict` + `noUncheckedIndexedAccess`.
- **First migration** (`apps/api/drizzle/0000.sql`): `app` schema with
  `users` and `storage_objects` (wrapped_dek, key_version, plain_size, mime).
- **RDR1 encryption module** (`packages/shared/src/rdr1.ts`), exactly per
  SPECS §2: 16-byte plaintext header (magic/version/segment_size/nonce_prefix),
  AES-256-GCM per 64 KiB segment, per-object random DEK wrapped under the
  `storage-kek/v1` HKDF subkey (SPECS §1), `key_version` carried in metadata.
  Range reads fetch a single ranged ciphertext range from byte 0.
  Fails closed on: bad magic/version/segment size, any GCM tag failure,
  truncation, trailing bytes, reordered segments, wrong object id, wrong
  plainSize, unsupported key version.
- **Test suite** (`rdr1.test.ts`, 40 tests): round trips at sizes
  `0, 1, S-1, S, S+1, 3S, 3S+7`; every range-read boundary case; tamper
  (header + each segment ciphertext + tag + wrapped DEK + object-id binding);
  truncation; reordering; wrong DEK/master key; **frozen test vector**
  (`src/frozen-vector.json` + generator `scripts/gen-frozen-vector.mjs`)
  pinning the format byte-for-byte.
- **Thin S3 client** (`apps/api/src/storage/s3.ts`): path-style SigV4,
  put / get / ranged-get / head / delete.
- **`GET /v1/health`**: DB ping + encrypted round trip to Hippius
  (put → full get+decrypt → **ranged GET** + range-decrypt → delete).
  No auth. 200 only when db and storage are ok.
- **Web page** (`apps/web`): shows `api ok / db ok / storage ok (encrypted)`.
- **Infra**: production Dockerfile (api + worker from one image),
  `docker-compose.yml` (postgres 17 + api + worker, loopback 3100),
  `Caddyfile.reader` (host Caddy block: `/v1/*` → api, static web dist),
  `deploy.sh` (pull → migrate → up → health check, rollback hint),
  `.env.example` with placeholders, `.gitignore`.
- **CI** (`.github/workflows/ci.yml`): lint + typecheck + unit tests
  (Node 24, pnpm frozen lockfile); e2e job with a MinIO stand-in for
  Hippius (skeleton — Playwright tests land in later slices); on main:
  build api + web, push `ghcr.io/chironreawakened/custom-reader-api:<sha>`.

## Verification steps for the owner

Done automatically (already run locally before push; CI re-runs):

1. `pnpm -r lint && pnpm -r typecheck && pnpm -r test` → all green
   (40/40 shared tests pass, incl. the frozen vector).
2. `pnpm --filter @reader/api build && pnpm --filter @reader/web build` → ok.

To verify on the deployed stack (after owner setup, `docs/owner-setup.md`):

3. `curl -fsS https://<name>.duckdns.org/v1/health` →
   `{"api":"ok","db":"ok","storage":"ok (encrypted)"}` and HTTP 200.
   The `ranged_get: "supported"` detail in `details` is the live
   confirmation that Hippius supports S3 ranged GETs (SPECS §2 requirement).
4. Open `https://<name>.duckdns.org` in a browser → shows
   `api ok / db ok / storage ok (encrypted)`.
5. The health round-trip leaves no objects behind (it deletes the temp
   object). To see an actual stored object, upload one in a later slice
   and inspect it in the Hippius console: it must be unreadable
   ciphertext (header + GCM segments, no plaintext anywhere).
6. Back-gate check: `APP_MASTER_KEY` in `/home/ubuntu/reader/.env` is the
   only key for all content — confirm the owner has a backup.

## Known gaps (not blocking the slice; all tracked)

1. **DuckDNS hostname not chosen** (questions.md Q1b) — `Caddyfile.reader`
   and `.env.example` use placeholders; replace before deploy.
2. **Hippius account has no credit** (questions.md Q1) — PutObject fails
   with `InsufficientAccountCredit` until the owner tops up. Until then
   `/v1/health` reports `storage: "fail"` (expected). Ranged GET support is
   unit-tested against an in-memory S3; the live check is the first green
   storage round trip in the health endpoint.
3. **Static web delivery**: the Caddyfile serves `/srv/reader/web-dist`
   from the host; `deploy.sh` does not populate it yet (CI builds only the
   api image). Resolve at deploy time (copy `apps/web/dist` to the host, or
   add a caddy/web image later). The health *API* is unaffected.
4. **CI e2e job is a skeleton** — MinIO starts, but Playwright tests are
   wired in the slices that have e2e coverage (per PLAN).
5. **Node pin**: VPS system Node is 26; everything pins Node 24 per PLAN
   (CI, Dockerfiles, `engines`). Local validation ran on a local Node 24
   install. Confirmation requested in questions.md Q3.

## Deviations

None in crypto, schema, formats, or endpoints. Environment deviations
(single prod env, `ubuntu` with sudo, no dev stack) are owner decisions
recorded in questions.md Q4 and baked into AGENTS.md.
