/**
 * Slice 7 TTS API (SPECS §10, §12).
 *
 *   GET    /v1/documents/:documentId/sections/:sectionId/tts-chunks
 *          the section's chunk list (offsets only, never the text) computed
 *          from the section's canonical text, plus the current model/voice.
 *   POST   /v1/tts
 *          { documentId, sectionId, chunkIndex } → 200 { status: "ready",
 *          url } on a cache hit, 202 { status: "processing" } when a
 *          tts.chunk job was queued. Chunks are addressed, never free text —
 *          the proxy can't be abused as a general TTS service.
 *   GET    /v1/tts-audio/:cacheKey?exp&sig
 *          signed, sessionless MP3 stream (the signed-URL pattern of
 *          /v1/assets/:id; the signature is bound to cacheKey + userId).
 *
 * The user's OpenAI key lives in user_settings (PUT /v1/settings/openai-key,
 * progress-settings.ts). Without a key, POST /v1/tts answers 409
 * `no_openai_key` so the client can point at Settings.
 */
import { DOMParser } from "@xmldom/xmldom";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  ASSET_URL_LABEL,
  chunkCanonicalText,
  canonicalText,
  deriveSubkey,
  nextAssetExp,
  postTtsBody,
  signAsset,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  verifyAsset,
  type CTElement,
} from "@reader/shared";
import { getDb } from "../db/client.js";
import { documents, sections, ttsCache, userSettings } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { ObjectStore } from "../storage/object-store.js";
import type { Boss } from "../jobs/boss.js";
import { JOB_TTS_CHUNK } from "../jobs/boss.js";
import { ttsCacheKey } from "../services/tts.js";
import { csrfOk } from "../services/csrf.js";
import { authenticate, SESSION_COOKIE, type Authenticated } from "../services/session.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uniform error shape (SPECS §12). */
function err(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/** Cookie (web) or Bearer (RN/CLI) auth. */
async function authedUser(req: FastifyRequest, now: () => number): Promise<Authenticated | null> {
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

/** section HTML → canonical text: the same walk highlights.ts uses, so the
 *  offsets match what the web reader computes (SPECS §6). */
export function defaultTtsCanonicalize(html: string): string {
  // Stored section HTML is a sanitized <body> FRAGMENT — several top-level
  // elements. xmldom's XHTML parser requires one root element, so wrap it:
  // `body` is not a canonical block boundary, so the text is identical to
  // walking the fragment itself.
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "application/xhtml+xml");
  const body = doc.getElementsByTagName("body")[0] as unknown as CTElement | undefined;
  if (!body) return "";
  return canonicalText(body).text;
}

export interface TtsContext {
  config: AppConfig;
  objectStore: ObjectStore;
  boss: Boss;
  now?: (() => number) | undefined;
  /** Injectable for unit tests. */
  canonicalize?: ((html: string) => string) | undefined;
}

/** In-flight dedupe window: a chunk job that is running (or queued) is not
 *  enqueued twice while its singleton key is live. 10 min covers the slowest
 *  expected synthesis (a 1500-char chunk) plus retry backoff with margin. */
const TTS_JOB_SINGLETON_MINUTES = 10;

export async function registerTts(app: FastifyInstance, ctx: TtsContext) {
  const config = ctx.config;
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const objectStore = ctx.objectStore;
  const boss = ctx.boss;
  const canonicalize = ctx.canonicalize ?? defaultTtsCanonicalize;
  const subkey = deriveSubkey(config.masterKey, ASSET_URL_LABEL);

  // ---- helpers -------------------------------------------------------------

  async function readySection(
    documentId: string,
    sectionId: string,
    userId: string,
  ): Promise<{ section: (typeof sections.$inferSelect) } | null> {
    if (!UUID_RE.test(documentId) || !UUID_RE.test(sectionId)) return null;
    const db = getDb();
    const [doc] = await db
      .select({ id: documents.id, ingestState: documents.ingestState })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .limit(1);
    if (!doc || doc.ingestState !== "ready") return null;
    const [section] = await db
      .select()
      .from(sections)
      .where(and(eq(sections.id, sectionId), eq(sections.documentId, documentId), eq(sections.userId, userId)))
      .limit(1);
    if (!section) return null;
    return { section };
  }

  /** The section's chunk list from its stored (encrypted) HTML. */
  async function sectionChunks(
    section: { htmlObjectId: string | null; userId: string },
  ): Promise<ReturnType<typeof chunkCanonicalText>> {
    if (!section.htmlObjectId) return [];
    const html = new TextDecoder().decode(await objectStore.get(section.htmlObjectId));
    return chunkCanonicalText(canonicalize(html));
  }

  async function userTtsPrefs(userId: string) {
    const [row] = await getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    return {
      model: row?.ttsModel ?? TTS_DEFAULT_MODEL,
      voice: row?.ttsVoice ?? TTS_DEFAULT_VOICE,
      hasKey: Boolean(row?.openaiKeyEnc),
    };
  }

  /** Signed URL for a cached chunk (same 6-hour rolling window as assets). */
  function audioUrl(cacheKey: string, userId: string): string {
    const exp = nextAssetExp(now() / 1000);
    return `/v1/tts-audio/${cacheKey}?exp=${exp}&sig=${signAsset(cacheKey, userId, exp, subkey)}`;
  }

  // ---- GET /v1/documents/:documentId/sections/:sectionId/tts-chunks --------
  app.get("/v1/documents/:documentId/sections/:sectionId/tts-chunks", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const { documentId, sectionId } = req.params as { documentId: string; sectionId: string };

    const hit = await readySection(documentId, sectionId, authed.user.id);
    if (!hit) return err(reply, 404, "not_found", "no such section");

    const [prefs, chunks] = await Promise.all([userTtsPrefs(authed.user.id), sectionChunks(hit.section)]);
    return reply.status(200).send({
      chunks: chunks.map((c) => ({ index: c.index, startOffset: c.startOffset, endOffset: c.endOffset })),
      model: prefs.model,
      voice: prefs.voice,
    });
  });

  // ---- POST /v1/tts ----------------------------------------------------------
  app.post("/v1/tts", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "forbidden");

    const parsed = postTtsBody.safeParse(req.body);
    if (!parsed.success)
      return err(reply, 400, "invalid_request", parsed.error.issues.map((i) => i.message).join(", "));
    const { documentId, sectionId, chunkIndex } = parsed.data;

    const hit = await readySection(documentId, sectionId, authed.user.id);
    if (!hit) return err(reply, 404, "not_found", "no such section");

    const [prefs, chunks] = await Promise.all([userTtsPrefs(authed.user.id), sectionChunks(hit.section)]);
    if (!prefs.hasKey)
      return err(reply, 409, "no_openai_key", "add your OpenAI API key in Settings to use TTS");
    if (chunkIndex >= chunks.length)
      return err(reply, 404, "not_found", "no such chunk");
    const chunk = chunks[chunkIndex]!;

    const cacheKey = ttsCacheKey(prefs.model, prefs.voice, chunk.text);
    const [cached] = await getDb()
      .select()
      .from(ttsCache)
      .where(eq(ttsCache.cacheKey, cacheKey))
      .limit(1);
    if (cached?.objectId) {
      return reply.status(200).send({ status: "ready", url: audioUrl(cacheKey, authed.user.id) });
    }

    // Queue the synthesis; the singleton key (the cache key) dedupes
    // concurrent requests for the same chunk.
    await boss.send(
      JOB_TTS_CHUNK,
      {
        userId: authed.user.id,
        cacheKey,
        model: prefs.model,
        voice: prefs.voice,
        chunkText: chunk.text,
      },
      {
        singletonKey: cacheKey,
        singletonMinutes: TTS_JOB_SINGLETON_MINUTES,
      },
    );
    return reply.status(202).send({ status: "processing" });
  });

  // ---- GET /v1/tts-audio/:cacheKey (signed, sessionless) ---------------------
  app.get("/v1/tts-audio/:cacheKey", async (req, reply) => {
    const { cacheKey } = req.params as { cacheKey: string };
    const qp = req.query as Record<string, string | undefined>;
    const exp = Number(qp.exp ?? 0);
    const sig = qp.sig ?? "";

    const rows = await getDb().select().from(ttsCache).where(eq(ttsCache.cacheKey, cacheKey)).limit(1);
    const row = rows[0];
    if (!row || !exp || !verifyAsset(cacheKey, row.userId, exp, sig, subkey)) {
      return err(reply, 403, "bad_signature", "audio signature is invalid or expired");
    }
    if (!row.objectId) return err(reply, 503, "not_ready", "audio is not stored yet");
    const meta = await objectStore.meta(row.objectId);
    if (!meta) return err(reply, 503, "not_ready", "audio content is not stored");

    reply.header("cache-control", "private, max-age=3600");
    reply.header("content-type", "audio/mpeg");
    reply.header("accept-ranges", "bytes");

    // <audio> seeks with Range; support it like /v1/assets/:id does.
    const range = req.headers["range"];
    if (typeof range === "string") {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return err(reply, 416, "bad_range", "unsupported Range header");
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), meta.plainSize - 1) : meta.plainSize - 1;
      if (start >= meta.plainSize || start > end) {
        reply.header("content-range", `bytes */${meta.plainSize}`);
        return reply.status(416).send();
      }
      const data = await objectStore.getRange(row.objectId, start, end + 1);
      reply.header("content-range", `bytes ${start}-${end}/${meta.plainSize}`);
      reply.header("content-length", data.byteLength);
      return reply.status(206).send(data);
    }

    const data = await objectStore.get(row.objectId);
    reply.header("content-length", data.byteLength);
    return reply.status(200).send(data);
  });
}
