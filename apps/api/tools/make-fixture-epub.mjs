/**
 * Build a minimal valid EPUB 3 fixture (titlepage + 2 chapters + a PNG
 * image + nav TOC). Used by unit/e2e tests and local verification.
 *
 * Usage: node tools/make-fixture-epub.mjs <out.epub>
 */
import { writeFileSync } from "node:fs";

// 1x1 red PNG (1 byte per channel, 8-bit truecolor) — small but real.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const contentDocs = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:11111111-2222-3333-4444-555555555555</dc:identifier>
    <dc:title>Night Fixture Book</dc:title>
    <dc:creator>Tessa Tester</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="title"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="title.xhtml">Titlepage</a></li>
      <li><a href="ch1.xhtml">Chapter One</a></li>
      <li><a href="ch2.xhtml">Chapter Two</a></li>
    </ol>
  </nav>
</body>
</html>`;

const titlePage = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Titlepage</title></head>
<body>
  <h1>Night Fixture Book</h1>
  <p>by Tessa Tester</p>
  <img src="cover.png" alt="cover"/>
</body>
</html>`;

const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter One</title></head>
<body>
  <h2>Chapter One</h2>
  <p>The first chapter begins here. It has some words for the word count.</p>
  <p>Second paragraph: foxes jump over lazy dogs at night.</p>
  <img src="cover.png" alt="a picture"/>
</body>
</html>`;

const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter Two</title></head>
<body>
  <h2>Chapter Two</h2>
  <p>The second and final chapter. The end of the fixture book.</p>
</body>
</html>`;

// --- minimal zip writer (STORE, no compression) -----------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const entries = [
  ["mimetype", Buffer.from("application/epub+zip")],
  ["META-INF/container.xml", Buffer.from(container)],
  ["OEBPS/content.opf", Buffer.from(contentDocs)],
  ["OEBPS/nav.xhtml", Buffer.from(nav)],
  ["OEBPS/title.xhtml", Buffer.from(titlePage)],
  ["OEBPS/ch1.xhtml", Buffer.from(ch1)],
  ["OEBPS/ch2.xhtml", Buffer.from(ch2)],
  ["OEBPS/cover.png", PNG_1PX],
];

const localParts = [];
const centralParts = [];
let offset = 0;
for (const [name, data] of entries) {
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: store
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0x21, 12); // date (1980-01-01)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);
  offset += local.length + nameBuf.length + data.length;
}

const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);

const out = Buffer.concat([...localParts, ...centralParts, eocd]);
writeFileSync(process.argv[2] ?? "fixture.epub", out);
console.log(`wrote ${process.argv[2] ?? "fixture.epub"} (${out.length} bytes)`);
