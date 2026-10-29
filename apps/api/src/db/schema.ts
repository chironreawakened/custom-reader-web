import { integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

// Tables live in the "app" schema (migrations create it).

export const users = pgTable("app.users", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storageObjects = pgTable("app.storage_objects", {
  /** = S3 object key */
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  wrappedDek: text("wrapped_dek").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  plainSize: integer("plain_size").notNull(),
  mime: varchar("mime", { length: 127 }).notNull().default("application/octet-stream"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- remaining tables (SPECS §11), added in the slices that use them ---
// login_codes, sessions, documents, sections, toc_entries, assets, tags,
// document_tags, highlights, reading_progress, user_settings, tts_cache,
// backups  ->  declared in their slices' migrations.

export type User = typeof users.$inferSelect;
export type StorageObject = typeof storageObjects.$inferSelect;
