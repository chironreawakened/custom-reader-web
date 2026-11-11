/**
 * Slice 3 reading progress + user settings (SPECS §8, §11, §12).
 *
 *   GET  /v1/progress/:documentId   last read spot, or nulls (never opened).
 *   PUT  /v1/progress/:documentId   { locator, updatedAt } — last write wins.
 *   GET  /v1/settings               { readerPrefs, ttsModel, ttsVoice,
 *                                     openaiKeyLast4 } (defaults when no row).
 *   PUT  /v1/settings               { readerPrefs?, ttsModel?, ttsVoice? }
 *                                    — partial upsert.
 *   PUT  /v1/settings/openai-key    { key } — stores the user's OpenAI key,
 *                                    RDR1-subkey-encrypted (slice 7).
 *   DELETE /v1/settings/openai-key  — forgets the key.
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
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  putOpenAiKeyBody,
  type GetSettingsResponse,
  type ProgressResponse,
  type PutProgressBody,
  type PutSettingsBody,
} from "@reader/shared";
import { csrfOk } from "../services/csrf.js";
import { authenticate, SESSION_COOKIE, type Authenticated } from "../services/session.js";
import {
  API_KEY_ENC_VERSION,
  encryptOpenAiKey,
  looksLikeOpenAiKey,
  openAiKeyLast4,
} from "../services/openai-key.js";

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
    const body: GetSettingsResponse = {
      readerPrefs: row?.readerPrefs ?? DEFAULT_READER_PREFS,
      ttsModel: row?.ttsModel ?? TTS_DEFAULT_MODEL,
      ttsVoice: row?.ttsVoice ?? TTS_DEFAULT_VOICE,
      openaiKeyLast4: row?.openaiKeyLast4 ?? null,
    };
    return reply.status(200).send(body);
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
    // Partial: fetch the existing row and merge the provided fields onto it
    // so a { ttsVoice } write does not clobber stored readerPrefs.
    const [existing] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, authed.user.id));
    const merged = {
      readerPrefs: parsed.data.readerPrefs ?? existing?.readerPrefs ?? DEFAULT_READER_PREFS,
      ttsModel: parsed.data.ttsModel ?? existing?.ttsModel ?? TTS_DEFAULT_MODEL,
      ttsVoice: parsed.data.ttsVoice ?? existing?.ttsVoice ?? TTS_DEFAULT_VOICE,
    };
    await db
      .insert(userSettings)
      .values({ userId: authed.user.id, ...merged })
      .onConflictDoUpdate({
        target: [userSettings.userId],
        set: { ...merged },
      });

    const body: GetSettingsResponse = {
      readerPrefs: merged.readerPrefs,
      ttsModel: merged.ttsModel,
      ttsVoice: merged.ttsVoice,
      openaiKeyLast4: existing?.openaiKeyLast4 ?? null,
    };
    return reply.status(200).send(body);
  });

  // ---- slice 7: the user's OpenAI key (SPECS §12) ---------------------------
  // Stored encrypted under a master-key subkey (services/openai-key.ts); the
  // key is never returned — only its last four characters.

  app.put("/v1/settings/openai-key", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "forbidden");

    const parsed = putOpenAiKeyBody.safeParse(req.body);
    if (!parsed.success) {
      // TEMP debug (slice 7 e2e): log received key length only — never the value.
      const got = typeof req.body?.key === "string" ? req.body.key.length : -1;
      console.log(`[tts-debug] openai-key PUT rejected: received key length=${got}`);
      return err(
        reply,
        400,
        "invalid_request",
        parsed.error.issues.map((i) => i.message).join(", "),
      );
    }
    if (!looksLikeOpenAiKey(parsed.data.key))
      return err(reply, 400, "invalid_request", "key does not look like an OpenAI API key");
    const key = parsed.data.key;

    const db = getDb();
    const enc = encryptOpenAiKey(key, config.masterKey);
    const last4 = openAiKeyLast4(key);
    await db
      .insert(userSettings)
      .values({
        userId: authed.user.id,
        openaiKeyEnc: enc,
        openaiKeyLast4: last4,
        keyVersion: API_KEY_ENC_VERSION,
      })
      .onConflictDoUpdate({
        target: [userSettings.userId],
        set: { openaiKeyEnc: enc, openaiKeyLast4: last4, keyVersion: API_KEY_ENC_VERSION },
      });

    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, authed.user.id));
    const res: GetSettingsResponse = {
      readerPrefs: row?.readerPrefs ?? DEFAULT_READER_PREFS,
      ttsModel: row?.ttsModel ?? TTS_DEFAULT_MODEL,
      ttsVoice: row?.ttsVoice ?? TTS_DEFAULT_VOICE,
      openaiKeyLast4: last4,
    };
    return reply.status(200).send(res);
  });

  app.delete("/v1/settings/openai-key", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "forbidden");

    const db = getDb();
    await db
      .update(userSettings)
      .set({ openaiKeyEnc: null, openaiKeyLast4: null, keyVersion: null })
      .where(eq(userSettings.userId, authed.user.id));

    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, authed.user.id));
    const res: GetSettingsResponse = {
      readerPrefs: row?.readerPrefs ?? DEFAULT_READER_PREFS,
      ttsModel: row?.ttsModel ?? TTS_DEFAULT_MODEL,
      ttsVoice: row?.ttsVoice ?? TTS_DEFAULT_VOICE,
      openaiKeyLast4: null,
    };
    return reply.status(200).send(res);
  });
}
