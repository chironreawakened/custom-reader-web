/**
 * Thin encrypted object store (SPECS §2): every object written to Hippius is
 * RDR1-encrypted; the `storage_objects` row (wrapped DEK + plain size + mime)
 * is what the API uses to decrypt on read.
 *
 * Deliberately thin so a storage fallback can be added later (PLAN.md).
 */
import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Rdr1, type ObjectMeta } from "@reader/shared";
import { getDb } from "../db/client.js";
import { storageObjects } from "../db/schema.js";
import type { S3Storage } from "./s3.js";
import type { AppConfig } from "../config.js";

export interface StoredObject {
  id: string;
  wrappedDek: Uint8Array;
  plainSize: number;
  keyVersion: number;
  mime: string;
}

export interface ObjectStore {
  /** Encrypt + upload a full in-memory payload; insert the DB row. Returns the object id (S3 key). */
  put(plaintext: Uint8Array, userId: string, mime: string, objectId?: string): Promise<string>;
  /** Upload a ciphertext stream (already RDR1) to Hippius WITHOUT inserting the DB row (the streaming
   *  upload only learns the wrapped DEK / plain size when the stream ends). */
  putCiphertextStream(ciphertext: NodeJS.ReadableStream, objectId: string): Promise<void>;
  /** Insert a storage_objects row after a putCiphertextStream upload finished. */
  recordObject(objectId: string, meta: { wrappedDek: Uint8Array; plainSize: number; keyVersion: number }, userId: string, mime: string): Promise<void>;
  get(id: string): Promise<Uint8Array>;
  /** Ranged plaintext read (SPECS §2 range reads). */
  getRange(id: string, start: number, end: number): Promise<Uint8Array>;
  /** DB metadata for decryption (no ciphertext). */
  meta(id: string): Promise<StoredObject | null>;
  delete(id: string): Promise<void>;
}

export function createObjectStore(cfg: AppConfig, storage: S3Storage): ObjectStore {
  const rdr = new Rdr1(cfg.masterKey);

  async function insertRow(objectId: string, wrappedDek: Uint8Array, plainSize: number, keyVersion: number, mime: string, userId: string) {
    await getDb().insert(storageObjects).values({
      id: objectId,
      userId,
      wrappedDek: Buffer.from(wrappedDek).toString("base64"),
      keyVersion,
      plainSize,
      mime,
    });
  }

  return {
    async put(plaintext, userId, mime, objectId = randomUUID()) {
      const enc = rdr.encrypt(plaintext, objectId);
      await storage.put(objectId, enc.ciphertext, "application/octet-stream");
      await insertRow(objectId, enc.wrappedDek, enc.plainSize, enc.keyVersion, mime, userId);
      return objectId;
    },

    async putCiphertextStream(ciphertext, objectId) {
      // S3 PutObject needs a known Content-Length, so buffer the ciphertext to a
      // temp file (capped at the 200 MB upload limit) and upload it with a length.
      const tmp = join(tmpdir(), `rdr-ct-${objectId}`);
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(tmp);
        ws.on("finish", () => resolve());
        ws.on("error", reject);
        (ciphertext as NodeJS.ReadableStream).pipe(ws);
      });
      try {
        // The file is bounded by the 200 MB upload cap; read it back with a
        // known length so S3 PutObject gets a Content-Length.
        await storage.put(objectId, readFileSync(tmp), "application/octet-stream");
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          /* already gone */
        }
      }
    },

    async recordObject(objectId, meta, userId, mime) {
      await insertRow(objectId, meta.wrappedDek, meta.plainSize, meta.keyVersion, mime, userId);
    },

    async get(id) {
      const row = await this.meta(id);
      if (!row) throw new Error(`unknown storage object ${id}`);
      const ct = await storage.get(id);
      const ometa: ObjectMeta = {
        objectId: id,
        wrappedDek: row.wrappedDek,
        plainSize: row.plainSize,
        keyVersion: row.keyVersion,
      };
      return new Uint8Array(rdr.decrypt(ometa, ct));
    },

    async getRange(id, start, end) {
      const row = await this.meta(id);
      if (!row) throw new Error(`unknown storage object ${id}`);
      const ometa: ObjectMeta = {
        objectId: id,
        wrappedDek: row.wrappedDek,
        plainSize: row.plainSize,
        keyVersion: row.keyVersion,
      };
      return new Uint8Array(
        await rdr.fetchPlaintextRange(ometa, start, end, (off, len) => storage.getRange(id, off, len)),
      );
    },

    async meta(id) {
      const rows = await getDb().select().from(storageObjects).where(eq(storageObjects.id, id)).limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        wrappedDek: new Uint8Array(Buffer.from(r.wrappedDek, "base64")),
        plainSize: r.plainSize,
        keyVersion: r.keyVersion,
        mime: r.mime,
      };
    },

    async delete(id) {
      await getDb().delete(storageObjects).where(eq(storageObjects.id, id));
      await storage.delete(id).catch(() => {
        /* object may already be gone */
      });
    },
  };
}
