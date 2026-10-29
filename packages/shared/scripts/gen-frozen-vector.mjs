import { createCipheriv, hkdfSync } from "node:crypto";

const S = 65536;
const HEADER = 16;
const mk = Buffer.alloc(32, 0xab); // fixed master key for vectors
const kek = Buffer.from(
  hkdfSync("sha256", mk, Buffer.from("personal-reader/v1", "utf8"), Buffer.from("storage-kek/v1", "utf8"), 32),
);
const dek = Buffer.from("01".repeat(32), "hex");
const np = Buffer.from("a1a2a3a4a5a6a7", "hex");

// plaintext: 3S+7 deterministic bytes
const size = 3 * S + 7;
const pt = Buffer.alloc(size);
for (let i = 0; i < size; i++) pt[i] = (i * 31 + 7) & 0xff;

const header = Buffer.alloc(HEADER);
Buffer.from("RDR1").copy(header, 0);
header[4] = 1;
header.writeUInt32BE(S, 5);
np.copy(header, 9);

function segNonce(i, last) {
  const n = Buffer.alloc(12);
  np.copy(n, 0);
  n.writeUInt32BE(i >>> 0, 7);
  n[11] = last ? 1 : 0;
  return n;
}
function seal(k, n, aad, data) {
  const c = createCipheriv("aes-256-gcm", k, n);
  c.setAAD(aad);
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}

const n = 4;
const parts = [header];
for (let i = 0; i < n; i++) {
  const f = i * S;
  const t = Math.min(f + S, size);
  parts.push(seal(dek, segNonce(i, i === n - 1), header, pt.subarray(f, t)));
}
const ct = Buffer.concat(parts);

const wn = Buffer.from("cd".repeat(12), "hex");
const aad = Buffer.from("rdr-dek/v1|vector-object-id", "utf8");
const wd = Buffer.concat([wn, seal(kek, wn, aad, dek)]);

const out = {
  masterKeyHex: mk.toString("hex"),
  dekHex: dek.toString("hex"),
  noncePrefixHex: np.toString("hex"),
  wrapNonceHex: wn.toString("hex"),
  objectId: "vector-object-id",
  plainSize: size,
  wrappedDekHex: wd.toString("hex"),
  ciphertextHex: ct.toString("hex"),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
