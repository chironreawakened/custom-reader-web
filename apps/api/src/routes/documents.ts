/**
 * Slice 2 documents API (PLAN slice 2, SPECS §2, §3, §11, §12).
 *
 *   POST /v1/documents/upload          multipart, one file, max 200 MB.
 *                                      Streamed RDR1-encrypted to Hippius;
 *                                      document row + pg-boss job.
 *   GET  /v1/documents                 cursor-paginated library list.
 *   GET  /v1/documents/:id             document detail (+ cover URL).
 *   GET  /v1/documents/:id/toc         flat TOC with parent refs.
 *   GET  /v1/documents/:id/sections    reading-order section list.
 *   GET  /v1/documents/:id/sections/:sid
 *                                      section html, asset:<id> rewritten to
 *                                      short-lived signed URLs.
 *   GET  /v1/assets/:id?exp&sig        signed asset bytes (Range-capable).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { assets, documents, sections, tocEntries } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { ObjectStore } from "../storage/object-store.js";
import type { Boss } from "../jobs/boss.js";
import {
  ASSET_URL_LABEL,
  deriveSubkey,
  nextAssetExp,
  signAsset,
  verifyAsset,
} from "@reader/shared";
import { csrfOk } from "../services/csrf.js";
import { authenticate, SESSION_COOKIE, type Authenticated } from "../services/session.js";
import { JOB_EPUB_PROCESS } from "../jobs/boss.js";
import { streamEncrypt } from "../storage/rdr1-stream.js";

/** SPECS: uploads are capped at 200 MB (also enforced by Caddy `request_body`). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Uniform error shape (SPECS §12). */
function err(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/** Cookie (web) or Bearer (RN/CLI) auth. */
async function authedUser(
  req: FastifyRequest,
  config: AppConfig,
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

/** A mutating request is CSRF-checked when authenticated by cookie. */
function mutatingCsrfOk(req: FastifyRequest, config: AppConfig): boolean {
  const hasCookie = Boolean((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
  const hasBearer = typeof req.headers["authorization"] === "string" && req.headers["authorization"]!.startsWith("Bearer");
  if (hasBearer && !hasCookie) return true; // bearer is exempt
  return csrfOk(req, config);
}

function fileTitle(filename: string | undefined): string {
  const base = (filename ?? "untitled").replace(/\.epub$/i, "").replace(/[_-]+/g, " ").trim();
  return base || "untitled";
}

export interface DocumentsContext {
  config: AppConfig;
  objectStore: ObjectStore;
  boss: Boss;
  now?: (() => number) | undefined;
}

export async function registerDocuments(app: FastifyInstance, ctx: DocumentsContext) {
  const { config, objectStore, boss } = ctx;
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const assetSubkey = deriveSubkey(config.masterKey, ASSET_URL_LABEL);

  function assetUrl(assetId: string, userId: string): string {
    const exp = nextAssetExp(now() / 1000);
    return `/v1/assets/${assetId}?exp=${exp}&sig=${signAsset(assetId, userId, exp, assetSubkey)}`;
  }

  // ---- POST /v1/documents/upload -----------------------------------------
  app.post("/v1/documents/upload", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");

    // Single file field ("file"); @fastify/multipart enforces the size limit.
    let part;
    try {
      part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    } catch (e) {
      if (e instanceof Error && e.message.includes("File too large")) {
        return err(reply, 413, "too_large", `upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
      }
      return err(reply, 400, "invalid_request", "expected a single multipart file field");
    }
    if (!part) return err(reply, 400, "invalid_request", "expected a single multipart file field");

    const filename = part.filename;
    const docId = crypto.randomUUID();
    const objectId = crypto.randomUUID();

    // Encrypt on the fly and stream the ciphertext straight to Hippius —
    // the plaintext never sits whole in memory.
    const { ciphertext, onDone } = streamEncrypt(part.file, objectId, config.masterKey);
    try {
      const putP = objectStore.putCiphertextStream(ciphertext, objectId);
      const meta = await onDone;
      await putP;
      await objectStore.recordObject(objectId, meta, authed.user.id, "application/octet-stream");
    } catch (e) {
      // Best-effort cleanup: remove a partially uploaded object.
      await objectStore.delete(objectId).catch(() => {});
      req.log.error({ err: e }, "upload failed");
      return err(reply, 500, "storage_error", "could not store the upload");
    }

    const [doc] = await getDb()
      .insert(documents)
      .values({
        id: docId,
        userId: authed.user.id,
        type: "epub",
        title: fileTitle(filename),
        originalObjectId: objectId,
        ingestState: "pending",
      })
      .returning();

    try {
      await boss.send(JOB_EPUB_PROCESS, { documentId: docId });
    } catch (e) {
      req.log.error({ err: e }, "could not queue the epub job");
      // The document stays pending; the worker's stalled-job sweep will
      // pick it up (or the user re-uploads).
    }

    return reply.status(201).send({
      id: doc!.id,
      type: doc!.type,
      title: doc!.title,
      ingestState: doc!.ingestState,
      createdAt: doc!.createdAt.toISOString(),
    });
  });

  // ---- GET /v1/documents ---------------------------------------------------
  app.get("/v1/documents", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");

    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const rows = await getDb()
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.userId, authed.user.id),
          q.status ? eq(documents.status, q.status as never) : undefined,
          q.type ? eq(documents.type, q.type as never) : undefined,
        ),
      )
      .orderBy(desc(documents.updatedAt), desc(documents.createdAt))
      .limit(limit + 1);

    const nextCursor = rows.length > limit ? rows[limit]!.id : null;
    const items = rows.slice(0, limit).map((d) => ({
      id: d.id,
      type: d.type,
      title: d.title,
      author: d.author,
      language: d.language,
      status: d.status,
      ingestState: d.ingestState,
      ingestError: d.ingestError,
      wordCount: d.wordCount,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    }));
    return { items, nextCursor };
  });

  // ---- GET /v1/documents/:id ------------------------------------------------
  async function ownedDocument(docId: string, userId: string) {
    const rows = await getDb()
      .select()
      .from(documents)
      .where(and(eq(documents.id, docId), eq(documents.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  app.get("/v1/documents/:id", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const doc = await ownedDocument((req.params as { id: string }).id, authed.user.id);
    if (!doc) return err(reply, 404, "not_found", "no such document");

    const secCount = (
      await getDb().select({ n: sql<number>`count(*)` }).from(sections).where(eq(sections.documentId, doc.id))
    )[0]!.n;

    let coverUrl: string | null = null;
    if (doc.coverAssetId) coverUrl = assetUrl(doc.coverAssetId, authed.user.id);

    return {
      id: doc.id,
      type: doc.type,
      title: doc.title,
      author: doc.author,
      language: doc.language,
      status: doc.status,
      ingestState: doc.ingestState,
      ingestError: doc.ingestError,
      wordCount: doc.wordCount,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      sectionCount: secCount,
      coverUrl,
    };
  });

  // ---- GET /v1/documents/:id/toc --------------------------------------------
  app.get("/v1/documents/:id/toc", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const docId = (req.params as { id: string }).id;
    if (!(await ownedDocument(docId, authed.user.id))) return err(reply, 404, "not_found", "no such document");

    const rows = await getDb()
      .select()
      .from(tocEntries)
      .where(and(eq(tocEntries.documentId, docId), eq(tocEntries.userId, authed.user.id)))
      .orderBy(asc(tocEntries.idx));

    return {
      items: rows.map((t) => ({
        id: t.id,
        idx: t.idx,
        parentId: t.parentId,
        label: t.label,
        sectionId: t.sectionId,
      })),
    };
  });

  // ---- GET /v1/documents/:id/sections ----------------------------------------
  app.get("/v1/documents/:id/sections", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const docId = (req.params as { id: string }).id;
    if (!(await ownedDocument(docId, authed.user.id))) return err(reply, 404, "not_found", "no such document");

    const rows = await getDb()
      .select()
      .from(sections)
      .where(and(eq(sections.documentId, docId), eq(sections.userId, authed.user.id)))
      .orderBy(asc(sections.idx));

    return {
      items: rows.map((s) => ({
        id: s.id,
        idx: s.idx,
        title: s.title,
        canonicalLength: s.canonicalLength,
      })),
      total: rows.length,
    };
  });

  // ---- GET /v1/documents/:id/sections/:sid ------------------------------------
  app.get("/v1/documents/:id/sections/:sid", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const { id: docId, sid } = req.params as { id: string; sid: string };
    if (!(await ownedDocument(docId, authed.user.id))) return err(reply, 404, "not_found", "no such document");

    const secRows = await getDb()
      .select()
      .from(sections)
      .where(and(eq(sections.id, sid), eq(sections.documentId, docId), eq(sections.userId, authed.user.id)))
      .limit(1);
    const sec = secRows[0];
    if (!sec) return err(reply, 404, "not_found", "no such section");
    if (!sec.htmlObjectId) return err(reply, 503, "not_ready", "section content is not stored");

    const html = new TextDecoder().decode(await objectStore.get(sec.htmlObjectId));

    // Rewrite asset:<id> placeholders to short-lived signed URLs (SPECS §3).
    const assetRows = await getDb().select({ id: assets.id }).from(assets).where(eq(assets.documentId, docId));
    const known = new Set(assetRows.map((a) => a.id));
    const exp = nextAssetExp(now() / 1000);
    const rewritten = html.replace(/asset:([0-9a-fA-F-]{36})/g, (m, aid) =>
      known.has(aid) ? `/v1/assets/${aid}?exp=${exp}&sig=${signAsset(aid, authed.user.id, exp, assetSubkey)}` : m,
    );

    // prev/next in reading order.
    const neighbours = await getDb()
      .select({ id: sections.id, idx: sections.idx })
      .from(sections)
      .where(and(eq(sections.documentId, docId), or(lte(sections.idx, sec.idx), gt(sections.idx, sec.idx))))
      .orderBy(asc(sections.idx));
    const i = neighbours.findIndex((n) => n.id === sec.id);

    return {
      id: sec.id,
      idx: sec.idx,
      title: sec.title,
      html: rewritten,
      prevSectionId: i > 0 ? neighbours[i - 1]!.id : null,
      nextSectionId: i >= 0 && i < neighbours.length - 1 ? neighbours[i + 1]!.id : null,
    };
  });

  // ---- GET /v1/assets/:id (signed, Range-capable) -----------------------------
  app.get("/v1/assets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const qp = req.query as Record<string, string | undefined>;
    const exp = Number(qp.exp ?? 0);
    const sig = qp.sig ?? "";

    const rows = await getDb().select().from(assets).where(eq(assets.id, id)).limit(1);
    const asset = rows[0];
    if (!asset) return err(reply, 404, "not_found", "no such asset");
    if (!exp || !verifyAsset(id, asset.userId, exp, sig, assetSubkey)) {
      return err(reply, 403, "bad_signature", "asset signature is invalid or expired");
    }
    const meta = await objectStore.meta(asset.objectId);
    if (!meta) return err(reply, 503, "not_ready", "asset content is not stored");

    reply.header("cache-control", "private, max-age=3600");
    reply.header("content-type", asset.mime);

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
      const data = await objectStore.getRange(asset.objectId, start, end + 1);
      reply.header("content-range", `bytes ${start}-${end}/${meta.plainSize}`);
      reply.header("accept-ranges", "bytes");
      reply.header("content-length", data.byteLength);
      return reply.status(206).send(data);
    }

    const data = await objectStore.get(asset.objectId);
    reply.header("accept-ranges", "bytes");
    reply.header("content-length", data.byteLength);
    return reply.status(200).send(data);
  });
}
