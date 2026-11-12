/**
 * Slice 8 search vector builder (SPECS §9).
 *
 * Both the worker (sections) and the highlights route build `search_vector`
 * with the DOCUMENT's language config (english | finnish | simple). `null`
 * (undetectable language) falls back to `simple`.
 *
 * The text is truncated to `SEARCH_VECTOR_MAX_CHARS` before vectorizing:
 * a tsvector column is hard-capped at 1,048,575 bytes in Postgres, and
 * ~100k source chars keeps even an adversarial all-distinct-token section
 * (measured ≈ 250k bytes) comfortably under it. Section plaintext is never
 * stored in Postgres (only the vector), so truncation loses no searchable
 * body content beyond the very tail of an extremely long section.
 */
import { sql } from "drizzle-orm";

/** Hard cap on chars fed to `to_tsvector` (see the module doc). */
export const SEARCH_VECTOR_MAX_CHARS = 100_000;

/** The three FTS configs (SPECS §9). */
export type SearchLang = "english" | "finnish" | "simple";

/**
 * A `sql` chunk for the `search_vector` column: `to_tsvector(<config>, text)`.
 * The config is passed as a parameter (never interpolated) and defaults to
 * `simple` for a `null`/unknown language.
 */
export function searchVectorSql(language: SearchLang | null | undefined, text: string) {
  const config = language ?? "simple";
  const truncated = text.length > SEARCH_VECTOR_MAX_CHARS ? text.slice(0, SEARCH_VECTOR_MAX_CHARS) : text;
  return sql`to_tsvector(${config}::regconfig, ${truncated})`;
}
