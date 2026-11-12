/**
 * Slice 8 search contract (SPECS §9, §12) — shared by the API and the web
 * client. Source of the OpenAPI spec (slice 10).
 *
 * GET /v1/search?q= returns three independent result lists (documents,
 * sections, highlights), each ranked by `ts_rank` (descending) and capped.
 * The query is matched against the three FTS configs (english / finnish /
 * simple) OR'd together (SPECS §9), so a term resolves in whichever config
 * actually indexed the hit.
 */
import { z } from "zod";
import { documentType, docStatus } from "./documents.js";
import { highlightColor } from "./anchors.js";

/** Max query length (SPECS §9: the query is a websearch string). */
export const SEARCH_MAX_Q = 500;
/** Per-list result cap (one user's corpus stays small; keep it bounded). */
export const SEARCH_MAX_PER_LIST = 25;

/** Query params for GET /v1/search. */
export const searchQuery = z
  .object({
    /** websearch string (natural language; quoted phrases, "and"/"or"). */
    q: z.string().min(1).max(SEARCH_MAX_Q),
  })
  .strict();
export type SearchQuery = z.infer<typeof searchQuery>;

/** A matched document (metadata only — no content). */
export const searchDocumentHit = z.object({
  id: z.string().uuid(),
  type: documentType,
  title: z.string(),
  author: z.string().nullable(),
  language: z.enum(["english", "finnish", "simple"]).nullable(),
  status: docStatus,
  /** ts_rank of the document's section-vector aggregate (0..1). */
  rank: z.number().min(0).max(1),
});
export type SearchDocumentHit = z.infer<typeof searchDocumentHit>;

/** A matched section, with a reference to its parent document. */
export const searchSectionHit = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  idx: z.number().int(),
  title: z.string().nullable(),
  language: z.enum(["english", "finnish", "simple"]).nullable(),
  rank: z.number().min(0).max(1),
});
export type SearchSectionHit = z.infer<typeof searchSectionHit>;

/** A matched highlight, with a reference to its parent document. */
export const searchHighlightHit = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  /** The anchor's sectionId (null for PDF anchors). */
  sectionId: z.string().uuid().nullable(),
  exact: z.string(),
  color: highlightColor.nullable(),
  note: z.string().nullable(),
  rank: z.number().min(0).max(1),
});
export type SearchHighlightHit = z.infer<typeof searchHighlightHit>;

/** GET /v1/search response: three independently-ranked lists. */
export const searchResponse = z.object({
  q: z.string(),
  documents: z.array(searchDocumentHit),
  sections: z.array(searchSectionHit),
  highlights: z.array(searchHighlightHit),
});
export type SearchResponse = z.infer<typeof searchResponse>;
