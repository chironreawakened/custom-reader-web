/**
 * Slice 4 highlights contract (SPECS §7, §11, §12) — shared by the API and
 * the web client. Source of the OpenAPI spec (slice 10).
 */
import { z } from "zod";
import { highlightAnchor, highlightColor, type HighlightAnchor, type ReflowAnchor } from "./anchors.js";

export const highlightItem = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  /** Convenience for clients: the anchor's sectionId (null for PDF anchors). */
  sectionId: z.string().uuid().nullable(),
  anchor: highlightAnchor,
  exact: z.string(),
  color: highlightColor.nullable(),
  note: z.string().nullable(),
  /**
   * Server-computed (SPECS §7): false when the anchor no longer resolves in
   * the section's current canonical text — the item is still returned,
   * just not drawn in the text. PDF anchors resolve in the reader against
   * the page text layer and are reported non-orphaned.
   */
  orphaned: z.boolean(),
  /** Display title of the containing section ("Page N" for PDF anchors). */
  sectionTitle: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type HighlightItem = z.infer<typeof highlightItem>;

export const listHighlightsQuery = z.object({
  documentId: z.string().uuid().optional(),
});
export type ListHighlightsQuery = z.infer<typeof listHighlightsQuery>;

/** GET /v1/highlights — newest first. */
export const listHighlightsResponse = z.object({
  items: z.array(highlightItem),
  total: z.number().int(),
});
export type ListHighlightsResponse = z.infer<typeof listHighlightsResponse>;

/**
 * POST /v1/highlights — the client sends the anchor (built with
 * `buildReflowAnchor` from the section's canonical text) and its `exact`.
 * `documentId` is validated against the session; the section must belong
 * to it.
 */
export const postHighlightBody = z
  .object({
    documentId: z.string().uuid(),
    /** Reflow anchors (epub/article) or PDF anchors (slice 6 faithful mode). */
    anchor: highlightAnchor,
    exact: z.string().min(1).max(10_000),
    color: highlightColor.nullable().default(null),
    note: z.string().max(5_000).nullable().default(null),
  })
  .strict();
export type PostHighlightBody = z.infer<typeof postHighlightBody>;

/**
 * PATCH /v1/highlights/:id — partial update. Only the fields the client
 * actually sends are changed (zod .partial() keeps the rest untouched).
 */
export const patchHighlightBody = z
  .object({
    /** Omitted = unchanged; `null` = clear the colour. */
    color: highlightColor.nullable().optional(),
    /** Omitted = unchanged; `null` = clear the note. */
    note: z.string().max(5_000).nullable().optional(),
  })
  .strict();
export type PatchHighlightBody = z.infer<typeof patchHighlightBody>;

export type { ReflowAnchor };
