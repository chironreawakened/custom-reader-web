/**
 * Slice 3 reading-progress contract (SPECS §8, §11, §12) — shared by the API
 * and the web client. Source of the OpenAPI spec (slice 10).
 */
import { z } from "zod";

/**
 * A "where am I" locator (SPECS §8). `reflow` is the EPUB/article case;
 * `pdf` is reserved for the PDF reading mode (later slice).
 */
export const locator = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reflow"),
      sectionId: z.string().uuid(),
      /** Scroll offset inside the section, in px (0 = top of section). */
      offset: z.number().int().min(0).max(1_000_000),
      /** Position within the document, 0..1. */
      percent: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pdf"),
      page: z.number().int().min(0),
      percent: z.number().min(0).max(1),
    })
    .strict(),
]);
export type Locator = z.infer<typeof locator>;

/** GET /v1/progress/:documentId — nulls when the document has no saved spot. */
export const progressResponse = z.object({
  locator: locator.nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type ProgressResponse = z.infer<typeof progressResponse>;

/**
 * PUT /v1/progress/:documentId — the client carries its own updatedAt; the
 * server keeps the newer value (last write wins, SPECS §8).
 */
export const putProgressBody = z
  .object({
    locator,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PutProgressBody = z.infer<typeof putProgressBody>;

/**
 * Last-write-wins decision (SPECS §8): the incoming write wins unless an
 * existing value is the same instant or newer. Pure — unit-tested here.
 *
 * @param existing  ISO timestamp of the stored row, or null (no row).
 * @param incoming  ISO timestamp carried by the client.
 * @returns "write" when the row should be (over)written, "conflict" when the
 *          client is stale and the server must reject with 409.
 */
export function lastWriteWins(
  existing: string | null,
  incoming: string,
): "write" | "conflict" {
  if (existing === null) return "write";
  const e = Date.parse(existing);
  const i = Date.parse(incoming);
  if (Number.isNaN(e) || Number.isNaN(i)) return "conflict";
  return i >= e ? "write" : "conflict";
}
