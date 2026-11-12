/**
 * Slice 2 worker: pg-boss job handlers.
 *
 *   epub.process  — download the RDR1-encrypted original from Hippius,
 *                   parse it, store sections/assets/TOC encrypted, and mark
 *                   the document ready (or failed).
 *   backup.nightly — pg_dump (app schema) → RDR1 → Hippius + backups row;
 *                   retention: 14 daily, 8 weekly (PLAN "Backups").
 *
 * The worker container runs `node dist/worker.js` (same image as the API).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pgBoss from "pg-boss";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Rdr1, type ObjectMeta } from "@reader/shared";
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/client.js";
import { searchVectorSql } from "./db/search-vector.js";
import { assets, backups, documents, sections, tocEntries, ttsCache, users, userSettings } from "./db/schema.js";
import { createS3Storage } from "./storage/s3.js";
import { createObjectStore } from "./storage/object-store.js";
import { EpubError, PARSER_VERSION, parseEpub } from "./services/epub/parse-epub.js";
import { PDF_PARSER_VERSION, PdfError, parsePdf } from "./services/pdf/parse-pdf.js";
import { ARTICLE_PARSER_VERSION, ArticleError, extractArticle } from "./services/article/extract.js";
import { safeFetch, SsrfError } from "./services/ssrf/safe-fetch.js";
import { imageSize, mimeByPath } from "./services/epub/image-size.js";
import {
  JOB_ARTICLE_PROCESS,
  JOB_BACKUP_NIGHTLY,
  JOB_EPUB_PROCESS,
  JOB_PDF_PROCESS,
  JOB_TTS_CHUNK,
  type ArticleProcessJob,
  type EpubProcessJob,
  type PdfProcessJob,
  type TtsChunkJob,
} from "./jobs/boss.js";
import { backupKindFor } from "./jobs/backup-schedule.js";
import { decryptOpenAiKey } from "./services/openai-key.js";
import { OpenAiTtsError, synthesizeChunk } from "./services/tts.js";

const pExecFile = promisify(execFile);

const cfg = loadConfig();
const db = getDb();
const storage = createS3Storage(cfg);
const objectStore = createObjectStore(cfg, storage);
const rdr = new Rdr1(cfg.masterKey);

const boss = new pgBoss({
  connectionString: cfg.dbUrl,
  schema: "pgboss",
});
boss.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] pg-boss error", err);
});

// ---------------------------------------------------------------------------
// epub.process
// ---------------------------------------------------------------------------

/**
 * Claim a pending document (pending|failed → processing). Returns the
 * document row, or null when another worker got there first / it is already
 * ready. A failed document is re-claimable (owner re-queues by re-upload or
 * manually).
 */
async function claimDocument(docId: string) {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), inArray(documents.ingestState, ["pending", "failed"])))
    .for("update")
    .limit(1);
  const doc = rows[0];
  if (!doc) return null;
  await db
    .update(documents)
    .set({ ingestState: "processing", ingestError: null, updatedAt: new Date() })
    .where(eq(documents.id, docId));
  return doc;
}

async function processEpub(docId: string): Promise<void> {
  const doc = await claimDocument(docId);
  if (!doc) {
    // eslint-disable-next-line no-console
    console.log(`[worker] ${docId}: nothing to do (already processed or gone)`);
    return;
  }
  if (!doc.originalObjectId) {
    await markFailed(docId, "original upload object is missing");
    return;
  }

  // 1. Download the encrypted original and decrypt in memory.
  const epubBuffer = await objectStore.get(doc.originalObjectId);

  // 2. Parse (+ DRM check, spine, cover, assets, sections, TOC).
  let parsed;
  try {
    parsed = await parseEpub(epubBuffer);
  } catch (e) {
    await markFailed(docId, e instanceof EpubError ? e.message : "epub parsing failed");
    return;
  }
  if (parsed.drm) {
    await markFailed(docId, `DRM detected: ${parsed.drm.reason}`);
    return;
  }
  const { epub } = parsed;

  // 3. Store assets (encrypted) + rows.
  const sectionIds = new Map<number, string>(); // section idx -> uuid
  for (const a of epub.assets) {
    await objectStore.put(a.bytes, doc.userId, a.mime, a.id);
  }
  if (epub.assets.length > 0) {
    await db.insert(assets).values(
      epub.assets.map((a) => ({
        id: a.id,
        userId: doc.userId,
        documentId: docId,
        objectId: a.id,
        role: a.role,
        mime: a.mime,
        width: a.width,
        height: a.height,
      })),
    );
  }

  // 4. Store sections: sanitized HTML → encrypted object + row with tsvector.
  for (const s of epub.sections) {
    const secId = crypto.randomUUID();
    sectionIds.set(s.idx, secId);
    const htmlObjId = crypto.randomUUID();
    await objectStore.put(new TextEncoder().encode(s.html), doc.userId, "text/html", htmlObjId);
    await db.insert(sections).values({
      id: secId,
      userId: doc.userId,
      documentId: docId,
      idx: s.idx,
      title: s.title,
      htmlObjectId: htmlObjId,
      canonicalLength: s.canonicalLength,
      // Slice 8: index with the document's own language config (SPECS §9);
      // null language falls back to `simple`.
      searchVector: searchVectorSql(epub.language, s.canonicalText),
    });
  }

  // 5. TOC: two passes — insert, then link sectionId/parentId (both uuids we
  //    assign, so a single insert with parent map would also work; we do one
  //    pass with resolved refs).
  if (epub.toc.length > 0) {
    const tocIds = epub.toc.map(() => crypto.randomUUID());
    await db.insert(tocEntries).values(
      epub.toc.map((t, i) => ({
        id: tocIds[i]!,
        userId: doc.userId,
        documentId: docId,
        parentId: t.parentIdx != null ? tocIds[t.parentIdx] ?? null : null,
        idx: t.idx,
        label: t.label,
        sectionId: t.sectionIdx != null ? (sectionIds.get(t.sectionIdx) ?? null) : null,
        anchor: t.href,
      })),
    );
  }

  // 6. Finalize the document row.
  await db
    .update(documents)
    .set({
      title: epub.title || doc.title,
      author: epub.author,
      language: epub.language,
      coverAssetId: epub.coverAssetId,
      parserVersion: PARSER_VERSION,
      ingestState: "ready",
      wordCount: epub.wordCount,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, docId));

  // eslint-disable-next-line no-console
  console.log(`[worker] ${docId}: ready (${epub.sections.length} sections, ${epub.assets.length} assets)`);
}

async function markFailed(docId: string, error: string): Promise<void> {
  await db
    .update(documents)
    .set({ ingestState: "failed", ingestError: error, updatedAt: new Date() })
    .where(eq(documents.id, docId));
  // eslint-disable-next-line no-console
  console.error(`[worker] ${docId}: ${error}`);
}

// ---------------------------------------------------------------------------
// article.process (slice 5: URL articles)
// ---------------------------------------------------------------------------

/** Hard cap on one re-hosted image (the section html already survived a 5 MB
 *  document cap; images live in their own objects). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** The ci / local-verify stacks host the article fixture on loopback; prod
 *  must never reach it (safe-fetch vetoes loopback there). */
const ALLOW_LOOPBACK = cfg.env === "ci";

async function processArticle(docId: string): Promise<void> {
  const doc = await claimDocument(docId);
  if (!doc) {
    // eslint-disable-next-line no-console
    console.log(`[worker] ${docId}: nothing to do (already processed or gone)`);
    return;
  }
  if (!doc.sourceUrl) {
    await markFailed(docId, "article source URL is missing");
    return;
  }

  // 1. Fetch the page (SSRF-vetted, redirects re-vetted per hop).
  let htmlText: string;
  let finalUrl: string;
  let fetchedContentType: string | null;
  try {
    const fetched = await safeFetch(doc.sourceUrl, {
      maxBytes: MAX_HTML_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      allowLoopback: ALLOW_LOOPBACK,
    });
    if (fetched.status < 200 || fetched.status >= 300) {
      await markFailed(docId, `the page answered HTTP ${fetched.status}`);
      return;
    }
    htmlText = fetched.bytes.toString("utf8");
    finalUrl = fetched.finalUrl;
    fetchedContentType = fetched.contentType;
  } catch (e) {
    await markFailed(docId, e instanceof SsrfError ? `blocked address: ${e.message}` : "fetch failed: " + String(e));
    return;
  }
  if (fetchedContentType && !/text\/html|application\/xhtml/i.test(fetchedContentType)) {
    await markFailed(docId, "the URL does not serve an HTML page");
    return;
  }

  // 2. Extract + re-host images. Each image is fetched SSRF-safely too,
  //    encrypted, and stored as an asset; a failed download keeps the
  //    original src (the image just does not render — no crash).
  const assetIds: string[] = [];
  try {
    const article = await extractArticle(htmlText, finalUrl, async (img) => {
      try {
        const imgRes = await safeFetch(img.url, {
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: FETCH_TIMEOUT_MS,
          allowLoopback: ALLOW_LOOPBACK,
        });
        if (imgRes.status < 200 || imgRes.status >= 300) return null;
        const bytes = new Uint8Array(imgRes.bytes);
        const mime =
          imgRes.contentType?.split(";")[0] ??
          mimeByPath(img.url) ??
          "application/octet-stream";
        if (!mime.startsWith("image/")) return null;
        const assetId = crypto.randomUUID();
        await objectStore.put(bytes, doc.userId, mime, assetId);
        const size = imageSize(bytes);
        await db.insert(assets).values({
          id: assetId,
          userId: doc.userId,
          documentId: docId,
          objectId: assetId,
          role: "image",
          mime,
          width: size?.width ?? null,
          height: size?.height ?? null,
        });
        assetIds.push(assetId);
        return assetId;
      } catch {
        return null;
      }
    });

    // 3. Store the section (one section per article).
    const secId = crypto.randomUUID();
    const htmlObjId = crypto.randomUUID();
    await objectStore.put(new TextEncoder().encode(article.html), doc.userId, "text/html", htmlObjId);
    await db.insert(sections).values({
      id: secId,
      userId: doc.userId,
      documentId: docId,
      idx: 0,
      title: article.title,
      htmlObjectId: htmlObjId,
      canonicalLength: article.canonicalText.length,
      // Slice 8: index with the document's own language config (SPECS §9).
      searchVector: searchVectorSql(article.language, article.canonicalText),
    });

    // 4. Finalize the document row.
    await db
      .update(documents)
      .set({
        title: article.title,
        author: article.byline,
        language: article.language,
        parserVersion: ARTICLE_PARSER_VERSION,
        ingestState: "ready",
        wordCount: article.wordCount,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, docId));

    // eslint-disable-next-line no-console
    console.log(`[worker] ${docId}: ready (article, ${article.wordCount} words, ${assetIds.length} images)`);
  } catch (e) {
    // Best-effort: drop the image assets that already landed.
    for (const aid of assetIds) {
      await db.delete(assets).where(eq(assets.id, aid)).catch(() => {});
      await objectStore.delete(aid).catch(() => {});
    }
    await markFailed(docId, e instanceof ArticleError ? e.message : "article ingest failed: " + String(e));
  }
}

// ---------------------------------------------------------------------------
// pdf.process (slice 6: PDF faithful mode)
// ---------------------------------------------------------------------------

/**
 * PDF faithful ingest: the original bytes are already stored (the upload
 * streamed them), so this job only opens the PDF to read its outline, page
 * count and metadata, records an `original` asset (so the signed-URL route
 * can serve it) and flips the document to ready.
 *
 * The browser renders the original through pdf.js (range requests) — the
 * worker never rasterizes. Scanned PDFs (no text layer) are ready but
 * carry no text: the reader disables highlighting for them (SPECS §2).
 */
async function processPdf(docId: string): Promise<void> {
  const doc = await claimDocument(docId);
  if (!doc) {
    // eslint-disable-next-line no-console
    console.log(`[worker] ${docId}: nothing to do (already processed or gone)`);
    return;
  }
  if (doc.type !== "pdf") {
    // An epub row queued as pdf (re-queue, manual test) — route it home.
    await processEpub(docId);
    return;
  }
  if (!doc.originalObjectId) {
    await markFailed(docId, "original upload object is missing");
    return;
  }

  const pdfBuffer = await objectStore.get(doc.originalObjectId);

  let parsed;
  try {
    parsed = await parsePdf(pdfBuffer);
  } catch (e) {
    // Log the stack: without it, non-PdfError messages come back empty and
    // the failure is undiagnosable from CI (this is how the Node-24 toHex
    // regression was finally pinpointed).
    console.error(
      `[worker] ${docId}: pdf parse error: ${e instanceof Error ? e.stack : String(e)}`,
    );
    await markFailed(docId, e instanceof PdfError ? e.message : "pdf parsing failed");
    return;
  }

  // 1. The `original` asset: the signed-URL route signs BY ASSET, so the
  //    pdf.js URL hangs off this row (same storage object as the upload).
  const assetId = crypto.randomUUID();
  await db.insert(assets).values({
    id: assetId,
    userId: doc.userId,
    documentId: docId,
    objectId: doc.originalObjectId,
    role: "original",
    mime: "application/pdf",
    width: null,
    height: null,
  });

  // 2. The PDF outline IS the TOC (SPECS §2): toc_entries with page
  //    destinations (sectionId stays null).
  if (parsed.outline.length > 0) {
    const ids = new Map<number, string>();
    for (const e of parsed.outline) ids.set(e.idx, crypto.randomUUID());
    await db.insert(tocEntries).values(
      parsed.outline.map((e) => ({
        id: ids.get(e.idx)!,
        userId: doc.userId,
        documentId: docId,
        parentId: e.parentId != null ? (ids.get(e.parentId) ?? null) : null,
        idx: e.idx,
        label: e.label,
        sectionId: null,
        page: e.page,
        anchor: null,
      })),
    );
  }

  // 3. Finalize the document row. `pdfHasText` is the scanned flag the
  //    reader needs: false => no text layer => clear message, no
  //    highlighting (SPECS §2).
  await db
    .update(documents)
    .set({
      title: parsed.title || doc.title,
      author: parsed.author,
      parserVersion: PDF_PARSER_VERSION,
      ingestState: "ready",
      pageCount: parsed.pageCount,
      pdfModeAvailable: "faithful",
      pdfHasText: parsed.hasText,
      wordCount: parsed.wordCount,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, docId));

  // eslint-disable-next-line no-console
  console.log(
    `[worker] ${docId}: ready (pdf, ${parsed.pageCount} pages, ${parsed.outline.length} outline entries, ${parsed.hasText ? "text layer" : "NO text layer"})`,
  );
}

// ---------------------------------------------------------------------------
// backup.nightly
// ---------------------------------------------------------------------------

const DAILY_RETENTION = 14;
const WEEKLY_RETENTION = 8;
/** Backups run 03:00 Europe/Helsinki; Monday's run is the weekly one. */
const BACKUP_CRON = "0 3 * * *";

async function runBackup(kind: "daily" | "weekly"): Promise<void> {
  const dump = await pExecFile("pg_dump", [
    "--schema=app",
    "--format=plain",
    "--no-owner",
    "--no-privileges",
    "--dbname",
    cfg.dbUrl,
  ]);
  const dumpBuf = Buffer.from(dump.stdout);

  const objectId = crypto.randomUUID();
  const backupId = crypto.randomUUID();
  await objectStore.put(dumpBuf, SYSTEM_USER_ID(), "application/x-pg-dump", objectId);
  const [row] = await db.insert(backups).values({ id: backupId, objectId, kind }).returning();

  await pruneBackups();
  // eslint-disable-next-line no-console
  console.log(`[worker] backup ${kind} done: ${row!.id} (${dumpBuf.length} bytes)`);
}

/** The backups rows need a user_id on storage_objects; backups themselves
 *  have none. Use the system placeholder user (created below). */
let systemUserId: string | null = null;
function SYSTEM_USER_ID(): string {
  if (!systemUserId) throw new Error("system user not resolved");
  return systemUserId;
}
async function ensureSystemUser(): Promise<void> {
  const existing = await db.select().from(users).where(eq(users.email, "system@reader.local")).limit(1);
  if (existing[0]) {
    systemUserId = existing[0].id;
    return;
  }
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email: "system@reader.local" });
  systemUserId = id;
}

async function pruneBackups(): Promise<void> {
  // Keep the N newest per kind; delete the rest (row + encrypted object).
  for (const kind of ["daily", "weekly"] as const) {
    const keep = kind === "daily" ? DAILY_RETENTION : WEEKLY_RETENTION;
    const rows = await db
      .select()
      .from(backups)
      .where(eq(backups.kind, kind))
      .orderBy(desc(backups.createdAt));
    for (const b of rows.slice(keep)) {
      await db.delete(backups).where(eq(backups.id, b.id));
      await objectStore.delete(b.objectId).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

const shutdown = async (sig: string) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${sig}, shutting down`);
  await boss.stop({ timeout: 10 });
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await ensureSystemUser();
await boss.start();

await boss.createQueue(JOB_EPUB_PROCESS, {
  name: JOB_EPUB_PROCESS,
  expireInSeconds: 3600,
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  retentionSeconds: 7 * 24 * 3600,
});
await boss.work<EpubProcessJob>(
  JOB_EPUB_PROCESS,
  {
    batchSize: 2,
  },
  async (jobs) => {
    for (const job of jobs) {
      try {
        await processEpub(job.data.documentId);
      } catch (err) {
        const docId = (job.data as { documentId?: string }).documentId ?? "unknown";
        await markFailed(docId, "worker crashed: " + String(err)).catch(() => {});
        throw err;
      }
    }
  },
);

// Article ingest (slice 5). Fetch failures (DNS, blocked address, HTTP error)
// are terminal — retrying the same URL rarely helps — so no retries.
await boss.createQueue(JOB_ARTICLE_PROCESS, {
  name: JOB_ARTICLE_PROCESS,
  expireInSeconds: 3600,
  retryLimit: 0,
  retentionSeconds: 7 * 24 * 3600,
});
await boss.work<ArticleProcessJob>(
  JOB_ARTICLE_PROCESS,
  {
    batchSize: 1,
  },
  async (jobs) => {
    for (const job of jobs) {
      await processArticle(job.data.documentId);
    }
  },
);

// PDF ingest (slice 6). A failed parse (corrupt file, password) is terminal
// — retrying the same bytes won't help — so no retries.
await boss.createQueue(JOB_PDF_PROCESS, {
  name: JOB_PDF_PROCESS,
  expireInSeconds: 3600,
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  retentionSeconds: 7 * 24 * 3600,
});
await boss.work<PdfProcessJob>(
  JOB_PDF_PROCESS,
  {
    batchSize: 1,
  },
  async (jobs) => {
    for (const job of jobs) {
      try {
        await processPdf(job.data.documentId);
      } catch (err) {
        const docId = (job.data as { documentId?: string }).documentId ?? "unknown";
        await markFailed(docId, "worker crashed: " + String(err)).catch(() => {});
        throw err;
      }
    }
  },
);

// TTS chunk (slice 7): synthesize one chunk with the user's OpenAI key,
// encrypt the MP3 as an RDR1 object, and record it in tts_cache. The
// cache key doubles as the pg-boss singleton key, so concurrent POSTs for
// the same chunk share one job; a duplicate job finding a fresh cache row
// is a no-op. OpenAI 429s retry (the client will poll again anyway); a
// rejected key is terminal — retrying with the same key cannot help.
async function processTtsChunk(data: TtsChunkJob): Promise<void> {
  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, data.userId))
    .limit(1);
  if (!settings?.openaiKeyEnc) {
    // eslint-disable-next-line no-console
    console.log(`[worker] tts.chunk ${data.cacheKey}: user has no OpenAI key; dropping`);
    return;
  }
  const [existing] = await db
    .select()
    .from(ttsCache)
    .where(eq(ttsCache.cacheKey, data.cacheKey))
    .limit(1);
  if (existing?.objectId) {
    // eslint-disable-next-line no-console
    console.log(`[worker] tts.chunk ${data.cacheKey}: already cached; no-op`);
    return;
  }

  let apiKey: string;
  try {
    apiKey = decryptOpenAiKey(settings.openaiKeyEnc, cfg.masterKey);
  } catch {
    // Corrupted ciphertext — treat as "no key" rather than a crash loop.
    // eslint-disable-next-line no-console
    console.error(`[worker] tts.chunk ${data.cacheKey}: stored key undecryptable; dropping`);
    return;
  }

  let mp3: Uint8Array;
  try {
    mp3 = await synthesizeChunk({
      apiKey,
      model: data.model,
      voice: data.voice,
      text: data.chunkText,
      ...(cfg.openAiBaseUrl && { baseUrl: cfg.openAiBaseUrl }),
    });
  } catch (e) {
    if (e instanceof OpenAiTtsError && e.code === "tts_rate_limited") {
      throw e; // retry later (queue retryLimit) — the client polls anyway
    }
    if (e instanceof OpenAiTtsError && e.code === "bad_openai_key") {
      // eslint-disable-next-line no-console
      console.log(`[worker] tts.chunk ${data.cacheKey}: openai rejected the key; dropping`);
      return;
    }
    throw e;
  }

  const objectId = await objectStore.put(mp3, data.userId, "audio/mpeg");
  await db
    .insert(ttsCache)
    .values({ cacheKey: data.cacheKey, userId: data.userId, objectId })
    .onConflictDoNothing();
  // eslint-disable-next-line no-console
  console.log(`[worker] tts.chunk ${data.cacheKey}: cached (${mp3.byteLength} B mp3)`);
}

await boss.createQueue(JOB_TTS_CHUNK, {
  name: JOB_TTS_CHUNK,
  expireInSeconds: 3600,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retentionSeconds: 7 * 24 * 3600,
});
await boss.work<TtsChunkJob>(
  JOB_TTS_CHUNK,
  {
    batchSize: 1,
  },
  async (jobs) => {
    for (const job of jobs) {
      await processTtsChunk(job.data);
    }
  },
);

await boss.createQueue(JOB_BACKUP_NIGHTLY, {
  name: JOB_BACKUP_NIGHTLY,
  expireInSeconds: 3600,
  retentionSeconds: 7 * 24 * 3600,
});
await boss.work(
  JOB_BACKUP_NIGHTLY,
  {},
  async () => {
    // Monday's run counts as the weekly backup. The weekday is derived in
    // Europe/Helsinki (backup-schedule.ts) instead of UTC so the intent is
    // explicit and it stays correct if the cron hour ever moves below the
    // UTC offset (03:00 EET/EEST currently fires on the same UTC day).
    await runBackup(backupKindFor());
  },
);

await boss.schedule(JOB_BACKUP_NIGHTLY, BACKUP_CRON, {}, { tz: "Europe/Helsinki" });

// eslint-disable-next-line no-console
console.log(
  "[worker] started: epub.process + article.process + pdf.process + tts.chunk + backup.nightly",
);
