import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { Rdr1, SEGMENT_SIZE } from "@reader/shared";
import { streamEncrypt } from "./rdr1-stream.js";

const MASTER = new Uint8Array(32).fill(7); // 32-byte master key.
const RDR = new Rdr1(MASTER);

function toStream(chunks: Buffer[]): Readable {
  return Readable.from(chunks);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream as Readable) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}

describe("streamEncrypt", () => {
  it("decrypts back to the plaintext (single small segment)", async () => {
    const plain = Buffer.from("hello streaming world");
    const { ciphertext, onDone } = streamEncrypt(toStream([plain]), "obj-1", MASTER);
    const ct = await collect(ciphertext);
    const meta = await onDone;
    expect(meta.plainSize).toBe(plain.length);
    const dec = RDR.decrypt(
      { objectId: "obj-1", wrappedDek: meta.wrappedDek, plainSize: meta.plainSize },
      ct,
    );
    expect(dec.equals(plain)).toBe(true);
  });

  it("handles plaintext exactly one segment (last-flag on the only segment)", async () => {
    const plain = Buffer.alloc(SEGMENT_SIZE, 42);
    const { ciphertext, onDone } = streamEncrypt(toStream([plain]), "obj-2", MASTER);
    const ct = await collect(ciphertext);
    const meta = await onDone;
    const dec = RDR.decrypt(
      { objectId: "obj-2", wrappedDek: meta.wrappedDek, plainSize: meta.plainSize },
      ct,
    );
    expect(dec.equals(plain)).toBe(true);
  });

  it("handles two full segments + a partial tail, fed in odd chunk sizes", async () => {
    const plain = Buffer.alloc(SEGMENT_SIZE * 2 + 1234, 9);
    // Feed in awkward chunk boundaries to exercise the pending/hold logic.
    const chunks = [
      Buffer.from(plain.subarray(0, SEGMENT_SIZE - 7)),
      Buffer.from(plain.subarray(SEGMENT_SIZE - 7, SEGMENT_SIZE * 2 + 10)),
      Buffer.from(plain.subarray(SEGMENT_SIZE * 2 + 10)),
    ];
    const { ciphertext, onDone } = streamEncrypt(toStream(chunks), "obj-3", MASTER);
    const ct = await collect(ciphertext);
    const meta = await onDone;
    expect(meta.plainSize).toBe(plain.length);
    const dec = RDR.decrypt(
      { objectId: "obj-3", wrappedDek: meta.wrappedDek, plainSize: meta.plainSize },
      ct,
    );
    expect(dec.equals(plain)).toBe(true);
  });

  it("emits exactly one empty last segment for an empty stream", async () => {
    const { ciphertext, onDone } = streamEncrypt(toStream([]), "obj-4", MASTER);
    const ct = await collect(ciphertext);
    const meta = await onDone;
    expect(meta.plainSize).toBe(0);
    const dec = RDR.decrypt(
      { objectId: "obj-4", wrappedDek: meta.wrappedDek, plainSize: 0 },
      ct,
    );
    expect(dec.length).toBe(0);
  });

  it("rejects decrypt with a mismatched objectId (AAD binding)", async () => {
    const plain = Buffer.alloc(SEGMENT_SIZE + 5, 1);
    const { ciphertext, onDone } = streamEncrypt(toStream([plain]), "obj-5", MASTER);
    const ct = await collect(ciphertext);
    const meta = await onDone;
    expect(meta.keyVersion).toBe(1);
    // Header = 16 bytes; ciphertext must be larger than header + one segment.
    expect(ct.length).toBeGreaterThan(16 + SEGMENT_SIZE);
    // A wrong objectId in the AAD must fail decryption.
    expect(() =>
      RDR.decrypt(
        { objectId: "wrong-object", wrappedDek: meta.wrappedDek, plainSize: meta.plainSize },
        ct,
      ),
    ).toThrow();
  });
});
