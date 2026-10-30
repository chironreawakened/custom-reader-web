import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sessions, users, type User } from "../db/schema.js";

/** SPECS §4 session lifetimes. */
export const WEB_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const BEARER_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
/** Extend the expiry once fewer than this remain. */
const SLIDE_AFTER_MS = 12 * 60 * 60 * 1000; // 12 h
/** Absolute cap so a session can never live forever under sliding. */
const MAX_WEB_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BEARER_MS = 180 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "rdr_session";
export const SESSION_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
};

/** 32 random bytes, base64url. The raw token is shown once and never stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256(token) as lowercase hex — the only form kept in the DB. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function lifetime(kind: "web" | "bearer"): number {
  return kind === "web" ? WEB_LIFETIME_MS : BEARER_LIFETIME_MS;
}
function maxLife(kind: "web" | "bearer"): number {
  return kind === "web" ? MAX_WEB_MS : MAX_BEARER_MS;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  kind: "web" | "bearer",
  userAgent: string | undefined,
  now: () => number = () => Date.now(),
): Promise<CreatedSession> {
  const token = newSessionToken();
  const nowMs = now();
  const expiresAt = new Date(nowMs + lifetime(kind));
  const db = getDb();
  const [row] = await db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashToken(token),
      kind,
      userAgent: userAgent ?? null,
      createdAt: new Date(nowMs),
      lastSeenAt: new Date(nowMs),
      expiresAt,
    })
    .returning();
  return { token, sessionId: row!.id, expiresAt };
}

export interface Authenticated {
  user: User;
  sessionId: string;
  kind: "web" | "bearer";
  expiresAt: Date;
}

/**
 * Look up a session by its raw token and apply sliding expiry.
 * Returns null when the token is unknown, revoked or expired.
 */
export async function authenticate(
  token: string,
  now: () => number = () => Date.now(),
): Promise<Authenticated | null> {
  const db = getDb();
  const nowMs = now();
  const th = hashToken(token);

  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      kind: sessions.kind,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      userEmail: users.email,
      userCreatedAt: users.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, th))
    .limit(1);

  const s = rows[0];
  if (!s) return null;
  if (s.revokedAt) return null;
  const expMs = s.expiresAt.getTime();
  if (nowMs >= expMs) return null;

  // Sliding: extend the expiry when less than SLIDE_AFTER_MS remains, capped at
  // created + maxLife so a session cannot be immortal.
  const createdMs = s.createdAt.getTime();
  const maxMs = createdMs + maxLife(s.kind);
  let newExp = s.expiresAt;
  if (expMs - nowMs < SLIDE_AFTER_MS) {
    const candidate = Math.min(nowMs + lifetime(s.kind), maxMs);
    if (candidate > expMs) newExp = new Date(candidate);
  }

  await db
    .update(sessions)
    .set({ lastSeenAt: new Date(nowMs), expiresAt: newExp })
    .where(eq(sessions.id, s.sessionId));

  return {
    user: {
      id: s.userId,
      email: s.userEmail,
      createdAt: s.userCreatedAt,
    },
    sessionId: s.sessionId,
    kind: s.kind,
    expiresAt: newExp,
  };
}

/** Revoke a session by its raw token (logout). */
export async function revokeByToken(
  token: string,
  now: () => number = () => Date.now(),
): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date(now()) })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
}

/** Revoke a session by id (used by logout after authentication). */
export async function revokeById(sessionId: string, now: () => number = () => Date.now()): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date(now()) })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}
