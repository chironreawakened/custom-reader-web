import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Rdr1, type ObjectMeta } from "@reader/shared";
import { getDb } from "../db/client.js";
import type { S3Storage } from "../storage/s3.js";
import type { AppConfig } from "../config.js";

export interface HealthReport {
  api: "ok";
  db: "ok" | "fail";
  storage: "ok (encrypted)" | "fail";
  details?: Record<string, string>;
}

export function makeHealthService(cfg: AppConfig, storage: S3Storage): () => Promise<HealthReport> {
  const rdr = new Rdr1(cfg.masterKey);
  return async () => {
    const report: HealthReport = { api: "ok", db: "ok", storage: "ok (encrypted)", details: {} };

    // 1) DB reachable
    try {
      await getDb().execute(sql`select 1`);
    } catch (e) {
      report.db = "fail";
      report.details!.db = String(e);
    }

    // 2) Encrypted round trip to Hippius + ranged GET (SPECS §2).
    // No DB rows involved: health objects are temporary and userless.
    try {
      const objectId = randomUUID();
      const plain = new TextEncoder().encode(`rdr-health ${new Date().toISOString()}`);
      const enc = rdr.encrypt(plain, objectId);
      await storage.put(objectId, enc.ciphertext, "application/octet-stream");

      // full read + decrypt
      const stored = await storage.get(objectId);
      const meta: ObjectMeta = { objectId, wrappedDek: enc.wrappedDek, plainSize: enc.plainSize };
      const out = rdr.decrypt(meta, stored);
      if (Buffer.compare(Buffer.from(out), plain) !== 0) {
        throw new Error("decrypted bytes do not match plaintext");
      }

      // ranged read: fetch the 16-byte header + first segment ciphertext and
      // decrypt just the plaintext range [0, plainSize) through it.
      const ranged = await rdr.fetchPlaintextRange(
        meta,
        0,
        plain.length,
        (off, len) => storage.getRange(objectId, off, len),
      );
      if (Buffer.compare(ranged, plain) !== 0) {
        throw new Error("range-decrypted bytes do not match plaintext");
      }

      report.details!.ciphertext_bytes = String(enc.ciphertext.length);
      report.details!.ranged_get = "supported";

      await storage.delete(objectId);
    } catch (e) {
      report.storage = "fail";
      report.details!.storage = String(e);
    }

    return report;
  };
}
