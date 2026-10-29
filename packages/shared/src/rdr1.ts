/**
 * RDR1 encrypted object format (SPECS §2) + key derivation (SPECS §1).
 *
 * STREAM construction, AES-256-GCM per 64 KiB segment:
 *
 *   header (16 bytes, plaintext):
 *     magic         4 bytes  "RDR1"
 *     version       1 byte   0x01
 *     segment_size  4 bytes  big-endian uint32 = 65536
 *     nonce_prefix  7 bytes  random
 *   segments:
 *     segment i = GCM ciphertext(plaintext[i*S .. min((i+1)*S, size))) || tag(16)
 *
 *   - nonce(i) = nonce_prefix(7) || uint32_be(i)(4) || last_flag(1)
 *   - AAD for every segment = the 16-byte header
 *   - ciphertext offset of segment i = 16 + i * (S + 16)
 *   - n = max(1, ceil(size / S)); empty plaintext = one empty last segment
 *
 * Data key: random 32-byte DEK per object, wrapped with AES-256-GCM under
 * the `storage-kek/v1` subkey, nonce(12) || ciphertext(32) || tag(16) = 60 B,
 * AAD = "rdr-dek/v1|" + object_id.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const RDR1_MAGIC = "RDR1";
export const RDR1_VERSION = 1;
export const SEGMENT_SIZE = 65536;
const HEADER_LEN = 16;
const GCM_TAG_LEN = 16;
export const KEK_LABEL = "storage-kek/v1";
export const HKDF_SALT = "personal-reader/v1";
export const KEY_VERSION = 1;

export class Rdr1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Rdr1Error";
  }
}

/** HKDF-SHA256 subkey derivation (SPECS §1). */
export function deriveSubkey(masterKey: Uint8Array, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.from(HKDF_SALT, "utf8"), Buffer.from(label, "utf8"), 32));
}

export function storageKek(masterKey: Uint8Array): Buffer {
  return deriveSubkey(masterKey, KEK_LABEL);
}

/** Validate a base64 APP_MASTER_KEY: must decode to exactly 32 bytes. */
export function validateMasterKey(base64: string): Buffer {
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== 32) {
    throw new Rdr1Error(`APP_MASTER_KEY must decode to exactly 32 bytes (got ${buf.length})`);
  }
  return buf;
}

export interface EncryptOptions {
  /** Deterministic DEK (tests/frozen vectors only). Default: fresh random. */
  dek?: Uint8Array;
  /** Deterministic 7-byte nonce prefix (tests/frozen vectors only). */
  noncePrefix?: Uint8Array;
}

export interface EncryptedObject {
  /** 60 bytes: nonce(12) || ct(32) || tag(16). */
  wrappedDek: Uint8Array;
  /** Header + all segment ciphertexts. */
  ciphertext: Uint8Array;
  /** Plaintext length in bytes. */
  plainSize: number;
  keyVersion: number;
}

export interface ObjectMeta {
  /** S3 object key (= storage_objects.id). Used in the DEK AAD. */
  objectId: string;
  /** 60-byte wrapped DEK. */
  wrappedDek: Uint8Array;
  /** Plaintext length in bytes. */
  plainSize: number;
  keyVersion?: number;
}

function segmentCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / SEGMENT_SIZE));
}

function lastSegmentLen(plainSize: number): number {
  const n = segmentCount(plainSize);
  return plainSize - (n - 1) * SEGMENT_SIZE;
}

/** Total ciphertext length for a given plaintext size. */
export function ciphertextLength(plainSize: number): number {
  const n = segmentCount(plainSize);
  return HEADER_LEN + (n - 1) * (SEGMENT_SIZE + GCM_TAG_LEN) + lastSegmentLen(plainSize) + GCM_TAG_LEN;
}

function ciphertextOffset(segmentIndex: number): number {
  return HEADER_LEN + segmentIndex * (SEGMENT_SIZE + GCM_TAG_LEN);
}

function segPlainLen(plainSize: number, segmentIndex: number): number {
  const n = segmentCount(plainSize);
  return segmentIndex === n - 1 ? lastSegmentLen(plainSize) : SEGMENT_SIZE;
}

function buildHeader(noncePrefix: Uint8Array): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  Buffer.from(RDR1_MAGIC, "ascii").copy(header, 0);
  header[4] = RDR1_VERSION;
  header.writeUInt32BE(SEGMENT_SIZE, 5);
  Buffer.from(noncePrefix).copy(header, 9);
  return header;
}

function segmentNonce(noncePrefix: Uint8Array, index: number, isLast: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  Buffer.from(noncePrefix).copy(nonce, 0);
  nonce.writeUInt32BE(index >>> 0, 7);
  nonce[11] = isLast ? 1 : 0;
  return nonce;
}

function aesGcmSeal(key: Buffer, nonce: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aesGcmOpen(key: Buffer, nonce: Buffer, aad: Buffer, ctWithTag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(ctWithTag.subarray(ctWithTag.length - GCM_TAG_LEN));
  try {
    return Buffer.concat([
      decipher.update(ctWithTag.subarray(0, ctWithTag.length - GCM_TAG_LEN)),
      decipher.final(),
    ]);
  } catch {
    throw new Rdr1Error("GCM authentication failed (tampered data, wrong key, or truncated segment)");
  }
}

function wrapDek(dek: Buffer, kek: Buffer, objectId: string): Buffer {
  if (dek.length !== 32) throw new Rdr1Error("DEK must be 32 bytes");
  const nonce = randomBytes(12);
  const aad = Buffer.from(`rdr-dek/v1|${objectId}`, "utf8");
  return Buffer.concat([nonce, aesGcmSeal(kek, nonce, aad, dek)]);
}

function unwrapDek(wrapped: Uint8Array, kek: Buffer, objectId: string): Buffer {
  if (wrapped.length !== 60) throw new Rdr1Error(`wrapped DEK must be 60 bytes (got ${wrapped.length})`);
  const nonce = Buffer.from(wrapped.subarray(0, 12));
  const aad = Buffer.from(`rdr-dek/v1|${objectId}`, "utf8");
  return aesGcmOpen(kek, nonce, aad, Buffer.from(wrapped.subarray(12)));
}

/**
 * Parse + validate the header, return (noncePrefix).
 * Fails on wrong magic/version/segment-size.
 */
function parseHeader(ciphertext: Uint8Array): Buffer {
  if (ciphertext.length < HEADER_LEN) throw new Rdr1Error("ciphertext shorter than header");
  const header = Buffer.from(ciphertext.subarray(0, HEADER_LEN));
  if (header.subarray(0, 4).toString("ascii") !== RDR1_MAGIC) throw new Rdr1Error("bad magic");
  if (header[4] !== RDR1_VERSION) throw new Rdr1Error("bad version");
  if (header.readUInt32BE(5) !== SEGMENT_SIZE) throw new Rdr1Error("bad segment size");
  return Buffer.from(ciphertext.subarray(9, 16));
}

export class Rdr1 {
  private readonly kek: Buffer;

  constructor(masterKey: Uint8Array) {
    if (masterKey.length !== 32) {
      throw new Rdr1Error(`master key must be 32 bytes (got ${masterKey.length})`);
    }
    this.kek = storageKek(masterKey);
  }

  encrypt(plaintext: Uint8Array, objectId: string, opts: EncryptOptions = {}): EncryptedObject {
    const dek = opts.dek ? Buffer.from(opts.dek) : randomBytes(32);
    const noncePrefix = opts.noncePrefix ? Buffer.from(opts.noncePrefix) : randomBytes(7);
    if (noncePrefix.length !== 7) throw new Rdr1Error("nonce prefix must be 7 bytes");
    const header = buildHeader(noncePrefix);

    const n = segmentCount(plaintext.length);
    const parts: Buffer[] = [header];
    for (let i = 0; i < n; i++) {
      const from = i * SEGMENT_SIZE;
      const to = Math.min(from + SEGMENT_SIZE, plaintext.length);
      parts.push(aesGcmSeal(dek, segmentNonce(noncePrefix, i, i === n - 1), header, Buffer.from(plaintext.subarray(from, to))));
    }

    return {
      wrappedDek: wrapDek(Buffer.from(dek), this.kek, objectId),
      ciphertext: new Uint8Array(Buffer.concat(parts)),
      plainSize: plaintext.length,
      keyVersion: KEY_VERSION,
    };
  }

  /**
   * Decrypt with an explicit DEK (used by tests / frozen vectors and by
   * `decrypt` after unwrapping). Validates the whole object: header fields,
   * exact total length (catches truncation and trailing garbage), and every
   * segment tag. Never returns partial plaintext as valid.
   */
  decryptWithDek(dek: Buffer, plainSize: number, ciphertext: Uint8Array): Buffer {
    const noncePrefix = parseHeader(ciphertext);
    const expectedLen = ciphertextLength(plainSize);
    if (ciphertext.length !== expectedLen) {
      throw new Rdr1Error(`bad ciphertext length ${ciphertext.length} (expected ${expectedLen} for plainSize ${plainSize})`);
    }
    const header = Buffer.from(ciphertext.subarray(0, HEADER_LEN));
    const n = segmentCount(plainSize);
    const out: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const off = ciphertextOffset(i);
      const len = segPlainLen(plainSize, i) + GCM_TAG_LEN;
      out.push(aesGcmOpen(dek, segmentNonce(noncePrefix, i, i === n - 1), header, Buffer.from(ciphertext.subarray(off, off + len))));
    }
    return Buffer.concat(out);
  }

  /** Decrypt the whole object. Throws Rdr1Error on any inconsistency. */
  decrypt(meta: ObjectMeta, ciphertext: Uint8Array): Buffer {
    const dek = this.unwrap(meta);
    return this.decryptWithDek(dek, meta.plainSize, ciphertext);
  }

  /**
   * Decrypt a plaintext byte range `[start, end)` (SPECS §2 range reads).
   * `fetchCiphertextRange(off, len)` must return exactly those ciphertext
   * bytes (typically one S3 ranged GET over the union range).
   */
  async fetchPlaintextRange(
    meta: ObjectMeta,
    start: number,
    end: number,
    fetchCiphertextRange: (offset: number, length: number) => Promise<Uint8Array>,
  ): Promise<Buffer> {
    const size = meta.plainSize;
    if (start < 0 || end > size || start > end) {
      throw new Rdr1Error(`range [${start}, ${end}) outside plaintext of size ${size}`);
    }
    if (start === end) return Buffer.alloc(0);

    const dek = this.unwrap(meta);
    const n = segmentCount(size);
    const i0 = Math.floor(start / SEGMENT_SIZE);
    const i1 = Math.floor((end - 1) / SEGMENT_SIZE);
    // Every segment's AAD is the 16-byte header, so the union fetch always
    // starts at offset 0 (one ranged GET: bytes=0..unionEnd).
    const unionStart = 0;
    const unionEnd = ciphertextOffset(i1) + segPlainLen(size, i1) + GCM_TAG_LEN;
    const union = Buffer.from(await fetchCiphertextRange(unionStart, unionEnd - unionStart));
    const header = Buffer.from(union.subarray(0, HEADER_LEN));
    const noncePrefix = parseHeader(union.subarray(0, HEADER_LEN));

    const out: Buffer[] = [];
    for (let i = i0; i <= i1; i++) {
      const segOff = ciphertextOffset(i) - unionStart;
      const segLen = segPlainLen(size, i) + GCM_TAG_LEN;
      const segPlaintext = aesGcmOpen(dek, segmentNonce(noncePrefix, i, i === n - 1), header, union.subarray(segOff, segOff + segLen));
      const from = i === i0 ? start - i * SEGMENT_SIZE : 0;
      const to = i === i1 ? end - i * SEGMENT_SIZE : SEGMENT_SIZE;
      out.push(segPlaintext.subarray(from, to));
    }
    return Buffer.concat(out);
  }

  private unwrap(meta: ObjectMeta): Buffer {
    const kv = meta.keyVersion ?? KEY_VERSION;
    if (kv !== KEY_VERSION) throw new Rdr1Error(`unsupported key_version ${kv}`);
    return unwrapDek(Buffer.from(meta.wrappedDek), this.kek, meta.objectId);
  }
}
