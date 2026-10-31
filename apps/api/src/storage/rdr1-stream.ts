/**
 * Streaming RDR1 encryptor for large uploads (SPECS §2, applied on the fly).
 *
 * Reads a plaintext Node stream, emits the RDR1 ciphertext as a Node
 * Readable (16-byte header first, then each 64 KiB segment sealed as it is
 * read) and resolves `onDone` with the wrapped DEK + plain size.
 *
 * Correctness: a segment can only be sealed with `last_flag=1` when the
 * stream has ended, so the encryptor holds the most recent *complete*
 * segment in `pending` and emits it as non-last; at flush, the pending
 * segment (or the final partial tail) is emitted as the last segment.
 * Memory is bounded: at most one held segment (64 KiB) + one partial buffer.
 *
 * The output is byte-identical to `Rdr1.encrypt` for the same DEK / nonce
 * prefix / plaintext — both use buildRdr1Header / rdr1SegmentNonce /
 * rdr1Seal / wrapRdr1Dek from @reader/shared — so a streamed object
 * decrypts through the normal `Rdr1.decrypt` / `fetchPlaintextRange` path.
 */
import { randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import {
  SEGMENT_SIZE,
  buildRdr1Header,
  rdr1Seal,
  rdr1SegmentNonce,
  wrapRdr1Dek,
} from "@reader/shared";

export interface StreamEncryptResult {
  /** RDR1 ciphertext (header + segments). Consume fully (e.g. S3 put). */
  ciphertext: NodeJS.ReadableStream;
  /** Resolves when the whole plaintext was consumed and sealed. */
  onDone: Promise<StreamEncryptMeta>;
}

export interface StreamEncryptMeta {
  wrappedDek: Uint8Array;
  plainSize: number;
  keyVersion: number;
}

export function streamEncrypt(
  plaintext: NodeJS.ReadableStream,
  objectId: string,
  masterKey: Uint8Array,
): StreamEncryptResult {
  const dek = randomBytes(32);
  const noncePrefix = randomBytes(7);
  const header = buildRdr1Header(noncePrefix);

  let segIndex = 0;
  let totalPlain = 0;
  let headerPushed = false;
  let pending: Buffer | null = null; // complete 64 KiB segment, not yet emitted
  let buf: Buffer = Buffer.alloc(0); // current partial segment (< 64 KiB)

  const emitSegment = (seg: Buffer, isLast: boolean, push: (b: Buffer) => void) => {
    const nonce = rdr1SegmentNonce(noncePrefix, segIndex++, isLast);
    push(rdr1Seal(dek, nonce, header, seg));
    totalPlain += seg.length;
  };

  let resolve!: (r: StreamEncryptMeta) => void;
  let reject!: (e: Error) => void;
  const onDone = new Promise<StreamEncryptMeta>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const transform = new Transform({
    highWaterMark: SEGMENT_SIZE * 2,
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!headerPushed) {
        this.push(header);
        headerPushed = true;
      }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= SEGMENT_SIZE) {
        const full = Buffer.from(buf.subarray(0, SEGMENT_SIZE));
        buf = Buffer.from(buf.subarray(SEGMENT_SIZE));
        if (pending) emitSegment(pending, false, (b) => this.push(b));
        pending = full;
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!headerPushed) {
        this.push(header);
        headerPushed = true;
      }
      try {
        if (pending && buf.length === 0) {
          emitSegment(pending, true, (b) => this.push(b));
        } else if (pending) {
          emitSegment(pending, false, (b) => this.push(b));
          emitSegment(buf, true, (b) => this.push(b));
        } else if (buf.length > 0) {
          emitSegment(buf, true, (b) => this.push(b));
        } else {
          // Empty plaintext = one empty last segment (SPECS §2).
          emitSegment(Buffer.alloc(0), true, (b) => this.push(b));
        }
        resolve({
          wrappedDek: wrapRdr1Dek(Buffer.from(dek), masterKey, objectId),
          plainSize: totalPlain,
          keyVersion: 1,
        });
        cb();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        cb();
      }
    },
  });

  plaintext.on("error", (e) => {
    reject(e);
    transform.destroy(e);
  });
  plaintext.pipe(transform);

  return { ciphertext: transform, onDone };
}
