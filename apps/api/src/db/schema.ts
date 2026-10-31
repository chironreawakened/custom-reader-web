import { pgSchema } from "drizzle-orm/pg-core";
import { customType, index, integer, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/** tsvector column (SPECS §9: only the tsvector of section text is stored). */
export const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

// Tables live in the Postgres schema "app" (created by migration 0000).
// NOTE: declare with pgSchema("app").table("users") — NOT pgTable("app.users"),
// which drizzle treats as a single table named "app.users" in the public schema.

export const app = pgSchema("app");

export const users = app.table("users", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storageObjects = app.table("storage_objects", {
  /** = S3 object key */
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  wrappedDek: text("wrapped_dek").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  plainSize: integer("plain_size").notNull(),
  mime: varchar("mime", { length: 127 }).notNull().default("application/octet-stream"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- slice 1: login codes and sessions (SPECS §4, §11) ---

export const loginCodes = app.table(
  "login_codes",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** HMAC-SHA256(otp-hmac/v1, user_id + "|" + code), hex. The code is never stored. */
    codeHmac: text("code_hmac").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** incremented on every wrong guess; code is invalid after 5 */
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestIp: text("request_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_codes_user_idx").on(t.userId, t.expiresAt)],
);

export const sessions = app.table(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256(token) hex; the raw token is shown once and never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind").$type<"web" | "bearer">().notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// --- slice 2: epub ingestion (SPECS §11) ---

export const documents = app.table(
  "documents",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<"epub" | "article" | "pdf">().notNull(),
    title: text("title").notNull(),
    author: text("author"),
    language: text("language").$type<"english" | "finnish" | "simple">(),
    status: text("status").$type<"inbox" | "later" | "archive">().notNull().default("inbox"),
    sourceUrl: text("source_url"),
    /** storage_objects.id of the RDR1-encrypted original upload. */
    originalObjectId: uuid("original_object_id").references(() => storageObjects.id, { onDelete: "set null" }),
    /**
     * assets.id of the cover image. Deliberately NOT a typed `.references()`
     * here: documents ↔ assets would be a two-way FK cycle that TypeScript
     * 5.9 cannot infer (TS7022). The reverse FK constraint is added in the
     * migration SQL (app.documents_cover_asset_id_fkey) instead.
     */
    coverAssetId: uuid("cover_asset_id"),
    parserVersion: integer("parser_version").notNull().default(1),
    ingestState: text("ingest_state").$type<"pending" | "processing" | "ready" | "failed">().notNull().default("pending"),
    ingestError: text("ingest_error"),
    wordCount: integer("word_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("documents_user_idx").on(t.userId, t.updatedAt)],
);

export const sections = app.table(
  "sections",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    title: text("title"),
    /** storage_objects.id of the RDR1-encrypted sanitized section HTML. */
    htmlObjectId: uuid("html_object_id").references(() => storageObjects.id, { onDelete: "set null" }),
    canonicalLength: integer("canonical_length"),
    /** tsvector of the section's canonical text (SPECS §9). */
    searchVector: tsvector("search_vector"),
  },
  (t) => [
    uniqueIndex("sections_document_idx_unique").on(t.documentId, t.idx),
    index("sections_search_idx").using("gin", t.searchVector),
  ],
);

export const tocEntries = app.table(
  "toc_entries",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    idx: integer("idx").notNull(),
    label: text("label").notNull(),
    sectionId: uuid("section_id").references(() => sections.id, { onDelete: "set null" }),
    anchor: text("anchor"),
  },
  (t) => [index("toc_document_idx").on(t.documentId)],
);

export const assets = app.table(
  "assets",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    /** storage_objects.id of the RDR1-encrypted asset bytes. */
    objectId: uuid("object_id").notNull().references(() => storageObjects.id, { onDelete: "set null" }),
    role: text("role").$type<"image" | "cover" | "original">().notNull(),
    mime: varchar("mime", { length: 127 }).notNull(),
    width: integer("width"),
    height: integer("height"),
  },
  (t) => [index("assets_document_idx").on(t.documentId)],
);

export const backups = app.table(
  "backups",
  {
    id: uuid("id").primaryKey(),
    /** storage_objects.id of the RDR1-encrypted pg_dump. */
    objectId: uuid("object_id").notNull().references(() => storageObjects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"daily" | "weekly">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("backups_kind_idx").on(t.kind, t.createdAt)],
);

// --- remaining tables (SPECS §11), added in the slices that use them ---
// tags, document_tags, highlights, reading_progress, user_settings,
// tts_cache  ->  their slices.

export type User = typeof users.$inferSelect;
export type StorageObject = typeof storageObjects.$inferSelect;
export type LoginCode = typeof loginCodes.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Section = typeof sections.$inferSelect;
export type TocEntry = typeof tocEntries.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Backup = typeof backups.$inferSelect;
