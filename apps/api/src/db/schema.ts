import { pgSchema } from "drizzle-orm/pg-core";
import { index, integer, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

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

// --- remaining tables (SPECS §11), added in the slices that use them ---
// documents, sections, toc_entries, assets, tags, document_tags, highlights,
// reading_progress, user_settings, tts_cache, backups  ->  their slices.

export type User = typeof users.$inferSelect;
export type StorageObject = typeof storageObjects.$inferSelect;
export type LoginCode = typeof loginCodes.$inferSelect;
export type Session = typeof sessions.$inferSelect;
