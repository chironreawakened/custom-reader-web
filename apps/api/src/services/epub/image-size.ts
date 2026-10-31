/**
 * Image dimensions from raw bytes (pure, no deps). Returns null for unknown
 * formats — dimensions are optional in the schema, so a null is always safe.
 * PNG, JPEG, GIF and the common WEBP sub-formats (VP8 lossy / VP8L lossless /
 * VP8X extended) are supported. Uses DataView (no Buffer) so it also runs in
 * browsers/RN if ever needed.
 */
export interface ImageSize {
  width: number;
  height: number;
}

function pngSize(d: DataView): ImageSize | null {
  // Signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR; width@16, height@20 (BE).
  if (d.byteLength < 24) return null;
  if (d.getUint8(0) !== 0x89 || d.getUint8(1) !== 0x50 || d.getUint8(2) !== 0x4e || d.getUint8(3) !== 0x47) return null;
  return { width: d.getUint32(16, false), height: d.getUint32(20, false) };
}

function gifSize(d: DataView): ImageSize | null {
  if (d.byteLength < 10) return null;
  if (
    d.getUint8(0) !== 0x47 || d.getUint8(1) !== 0x49 || d.getUint8(2) !== 0x46 // "GIF"
  ) {
    return null;
  }
  return { width: d.getUint16(6, true), height: d.getUint16(8, true) };
}

function jpegSize(d: DataView): ImageSize | null {
  if (d.byteLength < 4 || d.getUint8(0) !== 0xff || d.getUint8(1) !== 0xd8) return null;
  let i = 2;
  while (i + 4 < d.byteLength) {
    if (d.getUint8(i) !== 0xff) {
      i++;
      continue;
    }
    const marker = d.getUint8(i + 1);
    // Standalone markers (no length-prefixed payload).
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // SOF0..SOF15 (except DHT C4, JPG C8, DAC CC) carry height/width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > d.byteLength) return null;
      const height = d.getUint16(i + 5, false);
      const width = d.getUint16(i + 7, false);
      return { width, height };
    }
    const len = d.getUint16(i + 2, false);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(d: DataView): ImageSize | null {
  if (d.byteLength < 30) return null;
  const ascii = (from: number, to: number) =>
    String.fromCharCode(d.getUint8(from), d.getUint8(from + 1), d.getUint8(from + 2), d.getUint8(from + 3));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") return null;
  const chunk = ascii(12, 16);
  if (chunk === "VP8 ") {
    // Lossy: frame tag, then width(2 LE, low 14 bits), height(2 LE, low 14 bits).
    const width = d.getUint16(26, true) & 0x3fff;
    const height = d.getUint16(28, true) & 0x3fff;
    return { width, height };
  }
  if (chunk === "VP8L") {
    // Lossless: signature 0x2F then 4 packed bytes (width-1:14, height-1:14).
    if (d.getUint8(20) !== 0x2f) return null;
    const b0 = d.getUint8(21);
    const b1 = d.getUint8(22);
    const b2 = d.getUint8(23);
    const b3 = d.getUint8(24);
    const width = (b0 | ((b1 & 0x3f) << 8)) + 1;
    const height = (b2 | ((b3 & 0x1f) << 8)) | ((b1 & 0xc0) << 6);
    return { width, height };
  }
  if (chunk === "VP8X") {
    // Extended: canvas width-1 (3 LE) at offset 24, height-1 (3 LE) at 27.
    const width = (d.getUint8(24) | (d.getUint8(25) << 8) | (d.getUint8(26) << 16)) + 1;
    const height = (d.getUint8(27) | (d.getUint8(28) << 8) | (d.getUint8(29) << 16)) + 1;
    return { width, height };
  }
  return null;
}

export function imageSize(data: Uint8Array): ImageSize | null {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return pngSize(d) ?? gifSize(d) ?? jpegSize(d) ?? webpSize(d) ?? null;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

export function mimeByPath(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}
