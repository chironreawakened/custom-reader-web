/**
 * Slice 2 documents API contract (SPECS §12) — shared by the API and the web
 * client. These are the source of the OpenAPI spec (slice 10).
 */
import { z } from "zod";

export const documentType = z.enum(["epub", "article", "pdf"]);
export type DocumentType = z.infer<typeof documentType>;

export const docStatus = z.enum(["inbox", "later", "archive"]);
export type DocStatus = z.infer<typeof docStatus>;

export const ingestState = z.enum(["pending", "processing", "ready", "failed"]);
export type IngestState = z.infer<typeof ingestState>;

/** Metadata shape of one document (no content). */
export const documentMeta = z.object({
  id: z.string().uuid(),
  type: documentType,
  title: z.string(),
  author: z.string().nullable(),
  language: z.enum(["english", "finnish", "simple"]).nullable(),
  status: docStatus,
  ingestState,
  ingestError: z.string().nullable(),
  wordCount: z.number().int().nullable(),
  /**
   * PDF rendering modes available for this document (SPECS §11); null for
   * non-PDF documents. Slice 6 sets "faithful" (pdf.js over the original);
   * "both" is reserved for the reflow mode (slice 9).
   */
  pdfModeAvailable: z.enum(["faithful", "both"]).nullable(),
  /** PDF page count (null when unknown or not a PDF). */
  pageCount: z.number().int().nullable(),
  /**
   * PDF: extractable text layer present (slice 6). Null for non-PDF docs;
   * `false` = scanned (no text layer) — the reader shows a clear no-text
   * message and no highlighting (SPECS §2).
   */
  pdfHasText: z.boolean().nullable(),
  /** Tag names, alphabetized (SPECS §11; empty when untagged). */
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentMeta = z.infer<typeof documentMeta>;

/** GET /v1/documents — cursor-paginated (SPECS §12). */
export const listDocumentsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: docStatus.optional(),
  type: documentType.optional(),
  /** Filter to documents carrying this tag (SPECS §12). */
  tag: z.string().min(1).max(64).optional(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuery>;

export const listDocumentsResponse = z.object({
  items: z.array(documentMeta),
  nextCursor: z.string().nullable(),
});
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponse>;

/** GET /v1/documents/:id */
export const getDocumentResponse = z.object({
  ...documentMeta.shape,
  sectionCount: z.number().int(),
  coverUrl: z.string().nullable(),
});
export type GetDocumentResponse = z.infer<typeof getDocumentResponse>;

/** GET /v1/documents/:id/toc — flat list with parent refs (rendered as a tree). */
export const tocEntry = z.object({
  id: z.string().uuid(),
  idx: z.number().int(),
  parentId: z.string().uuid().nullable(),
  label: z.string(),
  sectionId: z.string().uuid().nullable(),
  /**
   * PDF outline target: the 1-based page to open (slice 6). Null for
   * epub/article entries.
   */
  page: z.number().int().nullable(),
});
export type TocEntryDto = z.infer<typeof tocEntry>;

export const tocResponse = z.object({
  items: z.array(tocEntry),
});
export type TocResponse = z.infer<typeof tocResponse>;

/** GET /v1/documents/:id/sections — the reading order list. */
export const sectionListItem = z.object({
  id: z.string().uuid(),
  idx: z.number().int(),
  title: z.string().nullable(),
  canonicalLength: z.number().int().nullable(),
});
export type SectionListItem = z.infer<typeof sectionListItem>;

export const listSectionsResponse = z.object({
  items: z.array(sectionListItem),
  total: z.number().int(),
});
export type ListSectionsResponse = z.infer<typeof listSectionsResponse>;

/** GET /v1/documents/:id/sections/:sid — html has asset:<id> rewritten to signed URLs. */
export const sectionResponse = z.object({
  id: z.string().uuid(),
  idx: z.number().int(),
  title: z.string().nullable(),
  html: z.string(),
  prevSectionId: z.string().uuid().nullable(),
  nextSectionId: z.string().uuid().nullable(),
});
export type SectionResponse = z.infer<typeof sectionResponse>;

// ---- slice 5: URL articles (SPECS §12) ------------------------------------

/** POST /v1/documents/url — fetch + ingest an article (async; document starts pending). */
export const postUrlBody = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => {
      try {
        const p = new URL(u);
        return p.protocol === "http:" || p.protocol === "https:";
      } catch {
        return false;
      }
    }, "only http(s) URLs are supported"),
});
export type PostUrlBody = z.infer<typeof postUrlBody>;

export const postUrlResponse = z.object({
  id: z.string().uuid(),
  type: z.literal("article"),
  title: z.string(),
  ingestState: ingestState,
  createdAt: z.string(),
});
export type PostUrlResponse = z.infer<typeof postUrlResponse>;

/**
 * GET /v1/documents/:id/original — the signed, range-capable URL of the
 * original upload (SPECS §12). pdf.js loads the PDF through it (slice 6).
 */
export const documentOriginalResponse = z.object({
  url: z.string(),
  pageCount: z.number().int().nullable(),
});
export type DocumentOriginalResponse = z.infer<typeof documentOriginalResponse>;

/** PATCH /v1/documents/:id — partial update; omit = unchanged, null = clear. */
export const patchDocumentBody = z.object({
  status: docStatus.optional(),
  title: z.string().min(1).max(500).optional(),
  author: z.string().max(500).nullable().optional(),
  language: z.enum(["english", "finnish", "simple"]).nullable().optional(),
  /** Full replacement set of tag ids (SPECS §12). */
  tagIds: z.array(z.string().uuid()).max(50).optional(),
});
export type PatchDocumentBody = z.infer<typeof patchDocumentBody>;

export const patchDocumentResponse = documentMeta.extend({
  tags: z.array(z.string()),
});
export type PatchDocumentResponse = z.infer<typeof patchDocumentResponse>;

/** One tag (SPECS §11: unique (user_id, lower(name))). */
export const tagItem = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
});
export type TagItem = z.infer<typeof tagItem>;

export const listTagsResponse = z.object({
  items: z.array(tagItem),
});
export type ListTagsResponse = z.infer<typeof listTagsResponse>;
