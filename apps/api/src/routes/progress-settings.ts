/**
 * Slice 3 reading progress + user settings (SPECS §8, §11, §12).
 *
 *   GET  /v1/progress/:documentId   last read spot, or nulls (never opened).
 *   PUT  /v1/progress/:documentId   { locator, updatedAt } — last write wins.
 *   GET  /v1/settings               { readerPrefs } (defaults when no row).
 *   PUT  /v1/settings               { readerPrefs } — upsert.
 *
 * All four require session auth. Cookie-authenticated mutating requests are
 * additionally CSRF-checked (X-Requested-With + Origin); bearer requests are
 * exempt (SPECS §4).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { readingProgress, userSettings } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import {
  DEFAULT_READER_PREFS,
  lastWriteWins,
  putProgressBody,
  putSettingsBody,
  type ProgressResponse,
  type PutProgressBody,
  type PutSettingsBody,
} from "@reader/shared";
import { csrfOk } from "../services/csrf.js";
import { authenticate, SESSION_COOKIE, type Authenticated } from "../services/session.js";

function err(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

async function authedUser(
  req: FastifyRequest,
  now: () => number,
): Promise<Authenticated | null> {
  const cookie = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
  let token = cookie;
  if (!token) {
    const h = req.headers["authorization"];
    const m = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h) : null;
    if (m) token = m[1];
  }
  if (!token) return null;
  return authenticate(token, now);
}

/** Mutating request is CSRF-checked when the session cookie is present;
 *  bearer-only requests are exempt (SPECS §4). */
function mutatingCsrfOk(req: FastifyRequest, config: AppConfig): boolean {
  const hasCookie = Boolean((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
  const hasBearer =
    typeof req.headers["authorization"] === "string" &&
    req.headers["authorization"]!.startsWith("Bearer");
  if (hasBearer && !hasCookie) return true;
  return csrfOk(req, config);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProgressSettingsContext {
  config: AppConfig;
  now?: (() => number) | undefined;
}

export async function registerProgressSettings(app: FastifyInstance, ctx: ProgressSettingsContext) {
  const config = ctx.config;
  const now = () => (ctx.now ? ctx.now() : Date.now());

  app.get("/v1/progress/:documentId", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const { documentId } = req.params as { documentId: string };
    if (!UUID_RE.test(documentId))
      return err(reply, 400, "invalid_request", "documentId is not a uuid");

    const db = getDb();
    const [row] = await db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, authed.user.id), eq(readingProgress.documentId, documentId)));
    const body: ProgressResponse = {
      locator: row ? (row.locator as PutProgressBody["locator"]) : null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
    return reply.status(200).send(body);
  });

  app.put("/v1/progress/:documentId", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "forbidden");
    const { documentId } = req.params as { documentId: string };
    if (!UUID_RE.test(documentId))
      return err(reply, 400, "invalid_request", "documentId is not a uuid");

    const parsed = putProgressBody.safeParse(req.body);
    if (!parsed.success)
      return err(
        reply,
        400,
        "invalid_request",
        parsed.error.issues.map((i) => i.message).join(", "),
      );

    const db = getDb();
    const [existing] = await db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, authed.user.id), eq(readingProgress.documentId, documentId)));

    // Last write wins (SPECS §8): the server keeps the newer value. A stale
    // client (updatedAt older than the stored row) gets 409, not a rollback.
    const decision = lastWriteWins(existing ? existing.updatedAt.toISOString() : null, parsed.data.updatedAt);
    if (decision === "conflict")
      return err(reply, 409, "conflict", "stored progress is newer; reload to refresh");

    const storedUpdatedAt = new Date(parsed.data.updatedAt);
    await db
      .insert(readingProgress)
      .values({
        userId: authed.user.id,
        documentId,
        locator: parsed.data.locator,
        updatedAt: storedUpdatedAt,
      })
      .onConflictDoUpdate({
        target: [readingProgress.userId, readingProgress.documentId],
        set: { locator: parsed.data.locator, updatedAt: storedUpdatedAt },
      });

    const body: ProgressResponse = {
      locator: parsed.data.locator,
      updatedAt: storedUpdatedAt.toISOString(),
    };
    return reply.status(200).send(body);
  });

  app.get("/v1/settings", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");

    const db = getDb();
    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, authed.user.id));
    return reply.status(200).send({ readerPrefs: row?.readerPrefs ?? DEFAULT_READER_PREFS });
  });

  app.put("/v1/settings", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "forbidden");

    const parsed = putSettingsBody.safeParse(req.body);
    if (!parsed.success)
      return err(
        reply,
        400,
        "invalid_request",
        parsed.error.issues.map((i) => i.message).join(", "),
      );

    const db = getDb();
    await db
      .insert(userSettings)
      .values({ userId: authed.user.id, readerPrefs: parsed.data.readerPrefs })
      .onConflictDoUpdate({
        target: [userSettings.userId],
        set: { readerPrefs: parsed.data.readerPrefs },
      });

    return reply.status(200).send({ readerPrefs: parsed.data.readerPrefs });
  });
}
