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
