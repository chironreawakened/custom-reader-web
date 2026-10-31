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
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Rdr1, type ObjectMeta } from "@reader/shared";
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/client.js";
import { assets, backups, documents, sections, users, tocEntries } from "./db/schema.js";
import { createS3Storage } from "./storage/s3.js";
import { createObjectStore } from "./storage/object-store.js";
import { EpubError, PARSER_VERSION, parseEpub } from "./services/epub/parse-epub.js";
import { JOB_BACKUP_NIGHTLY, JOB_EPUB_PROCESS, type EpubProcessJob } from "./jobs/boss.js";
import { backupKindFor } from "./jobs/backup-schedule.js";

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
      searchVector: sql`to_tsvector('simple', ${s.canonicalText})`,
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
console.log("[worker] started: epub.process + backup.nightly");
