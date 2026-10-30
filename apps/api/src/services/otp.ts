import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, gt, lt, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { loginCodes, users, type User } from "../db/schema.js";

/** SPECS §4 login-code parameters. */
export const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 min
export const MAX_ATTEMPTS = 5;

export interface OtpDeps {
  db: Db;
  /** the `otp-hmac/v1` subkey (32 bytes), derived from APP_MASTER_KEY. */
  otpSubkey: Buffer;
  now?: () => number;
}

/**
 * Compute the stored HMAC for a code:
 * HMAC-SHA256(otp-hmac/v1, user_id + "|" + code), hex. The code itself is
 * never stored.
 */
export function codeHmac(otpSubkey: Buffer, userId: string, code: string): string {
  return createHmac("sha256", otpSubkey).update(`${userId}|${code}`, "utf8").digest("hex");
}

function hmacEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface CreatedCode {
  code: string;
  expiresAt: Date;
}

/**
 * Create a fresh login code for a user, invalidating all older codes.
 * Returns the plaintext code (the caller decides to email it or print it).
 */
export async function requestCode(deps: OtpDeps, user: User, requestIp?: string): Promise<CreatedCode> {
  const { db, otpSubkey } = deps;
  const nowMs = deps.now ? deps.now() : Date.now();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(nowMs + CODE_EXPIRY_MS);

  // Requesting a new code invalidates older ones (SPECS §4).
  await db.delete(loginCodes).where(eq(loginCodes.userId, user.id));

  await db.insert(loginCodes).values({
    id: crypto.randomUUID(),
    userId: user.id,
    codeHmac: codeHmac(otpSubkey, user.id, code),
    expiresAt,
    attempts: 0,
    requestIp: requestIp ?? null,
  });

  return { code, expiresAt };
}

export type VerifyResult =
  | { ok: true; user: User }
  | { ok: false; reason: "none" | "expired" | "exhausted" | "used" | "bad" };

/**
 * Verify a code against the user's active code. On success the code is marked
 * single-use. Every wrong guess increments attempts; the code is invalid after
 * MAX_ATTEMPTS. Returns a reason for logging (never surfaced verbatim to the
 * client, which always gets the same generic 401).
 */
export async function verifyCode(deps: OtpDeps, user: User, code: string): Promise<VerifyResult> {
  const { db } = deps;
  const nowMs = deps.now ? deps.now() : Date.now();

  const rows = await db
    .select()
    .from(loginCodes)
    .where(eq(loginCodes.userId, user.id))
    .orderBy(desc(loginCodes.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "none" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= nowMs) return { ok: false, reason: "expired" };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "exhausted" };

  const expected = codeHmac(deps.otpSubkey, user.id, code);
  if (hmacEqual(expected, row.codeHmac)) {
    await db.update(loginCodes).set({ usedAt: new Date(nowMs) }).where(eq(loginCodes.id, row.id));
    return { ok: true, user };
  }

  // Wrong guess: increment attempts (code invalid after MAX_ATTEMPTS).
  await db.update(loginCodes).set({ attempts: row.attempts + 1 }).where(eq(loginCodes.id, row.id));
  return { ok: false, reason: "bad" };
}

/** Look up a user by email (lowercased). Used by the routes. */
export async function findUserByEmail(deps: Pick<OtpDeps, "db">, email: string): Promise<User | null> {
  const rows = await deps.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return rows[0] ?? null;
}
