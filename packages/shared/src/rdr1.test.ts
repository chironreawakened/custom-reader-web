import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KEY_VERSION,
  Rdr1,
  Rdr1Error,
  SEGMENT_SIZE,
  ciphertextLength,
  deriveSubkey,
  storageKek,
  validateMasterKey,
  type ObjectMeta,
} from "./rdr1.js";
import frozenRaw from "./frozen-vector.json";

const S = SEGMENT_SIZE;
const frozen = frozenRaw as {
  masterKeyHex: string;
  dekHex: string;
  noncePrefixHex: string;
  wrapNonceHex: string;
  objectId: string;
  plainSize: number;
  wrappedDekHex: string;
  ciphertextHex: string;
};

// --- helpers ---

function mkRdr(k?: Uint8Array): { rdr: Rdr1; key: Uint8Array } {
  const key = k ?? randomMasterKey();
  return { rdr: new Rdr1(key), key };
}

function randomMasterKey(): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

function deterministicBytes(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

function metaFor(rdr: Rdr1, objectId: string, plainSize: number, enc: { wrappedDek: Uint8Array }): ObjectMeta {
  return { objectId, wrappedDek: enc.wrappedDek, plainSize, keyVersion: KEY_VERSION };
}

/** In-memory S3-like object store: returns slices for ranged GETs. */
function memStore(ciphertext: Uint8Array) {
  return async (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > ciphertext.length) {
      throw new Error(`ranged GET out of bounds: ${offset}+${length} of ${ciphertext.length}`);
    }
    return ciphertext.subarray(offset, offset + length);
  };
}

describe("key derivation (SPECS §1)", () => {
  it("deriveSubkey is deterministic and 32 bytes", () => {
    const k = randomMasterKey();
    const a = deriveSubkey(k, "storage-kek/v1");
    const b = deriveSubkey(k, "storage-kek/v1");
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it("different labels give different subkeys", () => {
    const k = randomMasterKey();
    expect(deriveSubkey(k, "storage-kek/v1").equals(deriveSubkey(k, "asset-url/v1"))).toBe(false);
  });

  it("storageKek matches deriveSubkey('storage-kek/v1')", () => {
    const k = randomMasterKey();
    expect(storageKek(k).equals(deriveSubkey(k, "storage-kek/v1"))).toBe(true);
  });

  it("validateMasterKey accepts 32-byte base64 and rejects others", () => {
    expect(validateMasterKey(Buffer.alloc(32).toString("base64")).length).toBe(32);
    expect(() => validateMasterKey(Buffer.alloc(31).toString("base64"))).toThrow(Rdr1Error);
    expect(() => validateMasterKey("not-base64!!!")).toThrow(Rdr1Error);
  });
});

describe("RDR1 round trip (SPECS §2)", () => {
  const sizes = [0, 1, S - 1, S, S + 1, 3 * S, 3 * S + 7];

  for (const size of sizes) {
    it(`round-trips ${size} bytes`, () => {
      const { rdr } = mkRdr();
      const pt = deterministicBytes(size);
      const enc = rdr.encrypt(pt, "obj-1");
      expect(enc.plainSize).toBe(size);
      expect(enc.wrappedDek.length).toBe(60);
      expect(enc.ciphertext.length).toBe(ciphertextLength(size));
      const out = rdr.decrypt(metaFor(rdr, "obj-1", size, enc), enc.ciphertext);
      expect(Buffer.compare(out, pt)).toBe(0);
    });
  }

  it("empty plaintext is one empty last segment", () => {
    const { rdr } = mkRdr();
    const enc = rdr.encrypt(new Uint8Array(0), "obj-empty");
    // header + 16-byte tag of empty segment
    expect(enc.ciphertext.length).toBe(16 + 16);
    expect(rdr.decrypt(metaFor(rdr, "obj-empty", 0, enc), enc.ciphertext).length).toBe(0);
  });

  it("ciphertext is deterministic given the same DEK + nonce prefix", () => {
    const { rdr } = mkRdr();
    const dek = Buffer.alloc(32, 0x22);
    const np = Buffer.from("00112233445566", "hex");
    const pt = deterministicBytes(S + 10);
    const a = rdr.encrypt(pt, "obj-det", { dek, noncePrefix: np });
    const b = rdr.encrypt(pt, "obj-det", { dek, noncePrefix: np });
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(true);
  });

  it("different object ids produce different wrapped DEKs (AAD binding)", () => {
    const { rdr } = mkRdr();
    const dek = Buffer.alloc(32, 0x22);
    const np = Buffer.from("00112233445566", "hex");
    const pt = deterministicBytes(100);
    const a = rdr.encrypt(pt, "obj-a", { dek, noncePrefix: np });
    const b = rdr.encrypt(pt, "obj-b", { dek, noncePrefix: np });
    // segment ciphertexts identical (same DEK/np/plaintext)...
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(true);
    // ...but the wrapped DEK must NOT be, since its AAD includes the object id
    expect(Buffer.from(a.wrappedDek).equals(Buffer.from(b.wrappedDek))).toBe(false);
  });

  it("fails when the wrapped DEK came from a different object id", () => {
    const { rdr } = mkRdr();
    const dek = Buffer.alloc(32, 0x22);
    const np = Buffer.from("00112233445566", "hex");
    const pt = deterministicBytes(100);
    const a = rdr.encrypt(pt, "obj-a", { dek, noncePrefix: np });
    const swapped: ObjectMeta = { objectId: "obj-b", wrappedDek: a.wrappedDek, plainSize: pt.length };
    expect(() => rdr.decrypt(swapped, a.ciphertext)).toThrow(Rdr1Error);
  });
});

describe("RDR1 tamper / truncation / reordering (SPECS §2)", () => {
  const size = 3 * S + 123;
  let pt: Buffer;
  let enc: { wrappedDek: Uint8Array; ciphertext: Uint8Array };
  let rdr: Rdr1;
  let meta: ObjectMeta;

  function setup() {
    ({ rdr } = mkRdr());
    pt = deterministicBytes(size);
    enc = rdr.encrypt(pt, "obj-tamper");
    meta = metaFor(rdr, "obj-tamper", size, enc);
  }
  setup();

  it("rejects a flipped bit in the header (magic)", () => {
    const c = Buffer.from(enc.ciphertext);
    c[0] ^= 0x01; // "R" -> "A"
    expect(() => rdr.decrypt(meta, c)).toThrow(Rdr1Error);
  });

  it("rejects a bad version byte", () => {
    const c = Buffer.from(enc.ciphertext);
    c[4] = 0x02;
    expect(() => rdr.decrypt(meta, c)).toThrow(Rdr1Error);
  });

  it("rejects a bad segment_size field", () => {
    const c = Buffer.from(enc.ciphertext);
    c.writeUInt32BE(S + 1, 5);
    expect(() => rdr.decrypt(meta, c)).toThrow(Rdr1Error);
  });

  it("rejects a flipped bit inside each segment's ciphertext", () => {
    const c = Buffer.from(enc.ciphertext);
    // segments 0,1,2 are full; segment 3 is short. Flip a byte in each.
    for (const seg of [0, 1, 2, 3]) {
      const off = 16 + seg * (S + 16) + 10;
      const c2 = Buffer.from(enc.ciphertext);
      c2[off] ^= 0x80;
      expect(() => rdr.decrypt(meta, c2)).toThrow(Rdr1Error);
    }
  });

  it("rejects a flipped tag byte (each segment)", () => {
    for (const seg of [0, 1, 2, 3]) {
      const tagOff = 16 + seg * (S + 16) + (seg === 3 ? 123 : S) + 16 - 1;
      const c2 = Buffer.from(enc.ciphertext);
      c2[tagOff] ^= 0x01;
      expect(() => rdr.decrypt(meta, c2)).toThrow(Rdr1Error);
    }
  });

  it("rejects truncation: dropping the last segment", () => {
    const c = Buffer.from(enc.ciphertext);
    const lastStart = 16 + 3 * (S + 16);
    expect(() => rdr.decrypt(meta, c.subarray(0, lastStart))).toThrow(Rdr1Error);
  });

  it("rejects truncation: dropping bytes from the last segment", () => {
    const c = Buffer.from(enc.ciphertext);
    expect(() => rdr.decrypt(meta, c.subarray(0, c.length - 5))).toThrow(Rdr1Error);
  });

  it("rejects extra trailing bytes", () => {
    const c = Buffer.concat([Buffer.from(enc.ciphertext), Buffer.from([1, 2, 3])]);
    expect(() => rdr.decrypt(meta, c)).toThrow(Rdr1Error);
  });

  it("rejects reordered segments", () => {
    const full = Buffer.from(enc.ciphertext);
    const s0 = full.subarray(16, 16 + S + 16);
    const s1 = full.subarray(16 + (S + 16), 16 + 2 * (S + 16));
    // swap segments 0 and 1
    const reordered = Buffer.concat([full.subarray(0, 16), s1, s0, full.subarray(16 + 2 * (S + 16))]);
    expect(() => rdr.decrypt(meta, reordered)).toThrow(Rdr1Error);
  });

  it("rejects a wrong plainSize", () => {
    const bad: ObjectMeta = { ...meta, plainSize: size + 1 };
    expect(() => rdr.decrypt(bad, enc.ciphertext)).toThrow(Rdr1Error);
  });

  it("rejects an unsupported key_version", () => {
    const bad: ObjectMeta = { ...meta, keyVersion: 99 };
    expect(() => rdr.decrypt(bad, enc.ciphertext)).toThrow(Rdr1Error);
  });
});

describe("RDR1 range reads (SPECS §2)", () => {
  const size = 3 * S + 7;

  function setup() {
    const { rdr } = mkRdr();
    const pt = deterministicBytes(size);
    const enc = rdr.encrypt(pt, "obj-range");
    const meta = metaFor(rdr, "obj-range", size, enc);
    return { rdr, pt, meta, fetch: memStore(enc.ciphertext) };
  }

  it("full range equals full decrypt", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, 0, size, fetch);
    expect(Buffer.compare(out, pt)).toBe(0);
  });

  it("single segment interior", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, 10, 10 + 100, fetch);
    expect(Buffer.compare(out, pt.subarray(10, 110))).toBe(0);
  });

  it("exactly one segment, from 0 to S", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, 0, S, fetch);
    expect(Buffer.compare(out, pt.subarray(0, S))).toBe(0);
  });

  it("boundary: byte S-1 .. S+1 (spans segments 0 and 1)", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, S - 1, S + 1, fetch);
    expect(Buffer.compare(out, pt.subarray(S - 1, S + 1))).toBe(0);
  });

  it("boundary: starts exactly on segment edge S", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, S, S + 500, fetch);
    expect(Buffer.compare(out, pt.subarray(S, S + 500))).toBe(0);
  });

  it("boundary: ends exactly on segment edge 2S", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, 2 * S - 500, 2 * S, fetch);
    expect(Buffer.compare(out, pt.subarray(2 * S - 500, 2 * S))).toBe(0);
  });

  it("last (short) segment start to end", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, 3 * S, size, fetch);
    expect(Buffer.compare(out, pt.subarray(3 * S, size))).toBe(0);
  });

  it("single byte at the very end", async () => {
    const { rdr, pt, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, size - 1, size, fetch);
    expect(Buffer.compare(out, pt.subarray(size - 1, size))).toBe(0);
  });

  it("empty range returns empty", async () => {
    const { rdr, meta, fetch } = setup();
    const out = await rdr.fetchPlaintextRange(meta, 100, 100, fetch);
    expect(out.length).toBe(0);
  });

  it("rejects out-of-bounds ranges", async () => {
    const { rdr, meta, fetch } = setup();
    await expect(rdr.fetchPlaintextRange(meta, -1, 10, fetch)).rejects.toThrow(Rdr1Error);
    await expect(rdr.fetchPlaintextRange(meta, 0, size + 1, fetch)).rejects.toThrow(Rdr1Error);
    await expect(rdr.fetchPlaintextRange(meta, 10, 5, fetch)).rejects.toThrow(Rdr1Error);
  });

  it("range reads fail (no partial plaintext) when a fetched segment is tampered", async () => {
    const { rdr: r2 } = mkRdr();
    const pt2 = deterministicBytes(size);
    const enc2 = r2.encrypt(pt2, "obj-range3");
    const meta2 = metaFor(r2, "obj-range3", size, enc2);
    const ct = Buffer.from(enc2.ciphertext);
    ct[16 + 2 * (S + 16) + 5] ^= 0xff; // flip in segment 2
    const fetch2 = memStore(ct);
    await expect(r2.fetchPlaintextRange(meta2, 2 * S, 2 * S + 100, fetch2)).rejects.toThrow();
  });
});

describe("RDR1 frozen test vector (SPECS §2)", () => {
  it("reproduces the committed ciphertext byte-for-byte", () => {
    const key = Buffer.from(frozen.masterKeyHex, "hex");
    const rdr = new Rdr1(key);
    const pt = deterministicBytes(frozen.plainSize);
    const enc = rdr.encrypt(pt, frozen.objectId, {
      dek: Buffer.from(frozen.dekHex, "hex"),
      noncePrefix: Buffer.from(frozen.noncePrefixHex, "hex"),
    });
    // The wrap nonce is random by design, so the pinned assertion is on the
    // segment ciphertext (header + segments), which is fully determined by
    // DEK + nonce prefix + plaintext.
    expect(Buffer.from(enc.ciphertext).toString("hex")).toBe(frozen.ciphertextHex);

    // Full round trip with the frozen material.
    const meta: ObjectMeta = {
      objectId: frozen.objectId,
      wrappedDek: enc.wrappedDek,
      plainSize: frozen.plainSize,
    };
    expect(Buffer.compare(rdr.decrypt(meta, enc.ciphertext), pt)).toBe(0);
  });

  it("the committed wrapped DEK (fixed wrap nonce) is the stored one", () => {
    // Recompute wrap with the frozen wrap nonce to pin that too.
    const key = Buffer.from(frozen.masterKeyHex, "hex");
    const kek = storageKek(key);
    const dek = Buffer.from(frozen.dekHex, "hex");
    const wn = Buffer.from(frozen.wrapNonceHex, "hex");
    const aad = Buffer.from(`rdr-dek/v1|${frozen.objectId}`, "utf8");
    const c = createCipheriv("aes-256-gcm", kek, wn);
    c.setAAD(aad);
    const expected = Buffer.concat([wn, c.update(dek), c.final(), c.getAuthTag()]).toString("hex");
    expect(expected).toBe(frozen.wrappedDekHex);
  });

  it("rejects decryption with the frozen ciphertext under a different master key", () => {
    const other = new Rdr1(randomMasterKey());
    const meta: ObjectMeta = {
      objectId: frozen.objectId,
      wrappedDek: Buffer.from(frozen.wrappedDekHex, "hex"),
      plainSize: frozen.plainSize,
    };
    expect(() => other.decrypt(meta, Buffer.from(frozen.ciphertextHex, "hex"))).toThrow(Rdr1Error);
  });
});
