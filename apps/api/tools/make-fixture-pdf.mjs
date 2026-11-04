/**
 * Build minimal valid PDF fixtures (no deps — hand-assembled PDF 1.4).
 * Used by e2e + local verification so CI doesn't ship a binary in the repo.
 *
 * Usage:
 *   node tools/make-fixture-pdf.mjs <out.pdf> [outline|plain|scanned]
 *
 *   outline  (default)  2 pages of Helvetica text (a real text layer),
 *                       an Outlines tree (Chapter One / Chapter Two) with
 *                       direct page destinations, + /Title + /Author.
 *   plain              same two text pages, NO outline (the "without
 *                       outline" corpus entry).
 *   scanned            one page that is a JPEG image only — no text layer,
 *                       so the worker's probeText() reports hasText=false
 *                       and the reader shows the no-text message.
 *
 * The `outline` variant is byte-stable: its objects and layout are fixed so
 * the e2e assertions (title "Night Fixture PDF", 2 pages, 2 TOC entries,
 * page text) never drift.
 */
import { writeFileSync } from "node:fs";

function pageContentStream(lines) {
  let s = "";
  for (const [text, size, y] of lines) {
    const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    s += `BT /F1 ${size} Tf 72 ${y} Td (${esc}) Tj ET\n`;
  }
  return Buffer.from(s, "latin1");
}

const c1 = pageContentStream([
  ["Night Fixture PDF", 18, 720],
  ["The first chapter begins here. It has some words for the word count.", 12, 690],
  ["Second paragraph: foxes jump over lazy dogs at night.", 12, 670],
]);
const c2 = pageContentStream([
  ["Chapter Two", 18, 720],
  ["The second and final chapter. The end of the fixture PDF.", 12, 690],
]);

// Assemble `objs` (1-based) into a complete PDF: header, numbered objects
// with an xref table, and a trailer pointing at Root/Info.
function assemble(objs, root, info) {
  const n = Object.keys(objs).length;
  const out = [Buffer.from("%PDF-1.4\n")];
  const offsets = {};
  for (let i = 1; i <= n; i++) {
    offsets[i] = out.reduce((s, b) => s + b.length, 0);
    out.push(Buffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`));
  }
  const xrefPos = out.reduce((s, b) => s + b.length, 0);
  out.push(Buffer.from(`xref\n0 ${n + 1}\n0000000000 65535 f \n`));
  for (let i = 1; i <= n; i++) {
    out.push(Buffer.from(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`));
  }
  out.push(Buffer.from(`trailer\n<< /Size ${n + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`));
  return Buffer.concat(out);
}

function buildOutline({ withOutline }) {
  // Objects: 1 Catalog 2 Pages 3 Page1 4 Page2 5 Cont1 6 Cont2 7 Font
  // [8 Outlines 9 Item1 10 Item2] 11 Info
  const objs = {};
  objs[1] = Buffer.from(
    withOutline ? "<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>" : "<< /Type /Catalog /Pages 2 0 R >>",
  );
  objs[2] = Buffer.from("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
  objs[3] = Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>");
  objs[4] = Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>");
  objs[5] = Buffer.concat([Buffer.from(`<< /Length ${c1.length} >>\nstream\n`), c1, Buffer.from("\nendstream")]);
  objs[6] = Buffer.concat([Buffer.from(`<< /Length ${c2.length} >>\nstream\n`), c2, Buffer.from("\nendstream")]);
  objs[7] = Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  if (withOutline) {
    objs[8] = Buffer.from("<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>");
    objs[9] = Buffer.from("<< /Title (Chapter One) /Dest [3 0 R /XYZ 0 0 0] /Next 10 0 R /Parent 8 0 R >>");
    objs[10] = Buffer.from("<< /Title (Chapter Two) /Dest [4 0 R /XYZ 0 0 0] /Parent 8 0 R >>");
  }
  const info = withOutline ? 11 : 8;
  objs[info] = Buffer.from(
    withOutline
      ? "<< /Title (Night Fixture PDF) /Author (Tessa Tester) >>"
      : "<< /Title (Night Fixture PDF Plain) /Author (Tessa Tester) >>",
  );
  return assemble(objs, 1, info);
}

// A small (2x2, blue/white) JPEG — good enough to be a real raster page.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAoDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAX//2Q==",
  "base64",
);

function buildScanned() {
  // Objects: 1 Catalog 2 Pages 3 Page 4 Img 5 Content 6 Info
  const objs = {};
  objs[1] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objs[2] = Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objs[3] = Buffer.from(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /XObject << /Im0 4 0 R >> >> >>",
  );
  objs[4] = Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${JPEG.length} >>\nstream\n`,
    ),
    JPEG,
    Buffer.from("\nendstream"),
  ]);
  const content = Buffer.from("q 300 0 0 200 106 300 cm /Im0 Do Q\n");
  objs[5] = Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]);
  objs[6] = Buffer.from("<< /Title (Night Fixture PDF Scanned) /Author (Tessa Tester) >>");
  return assemble(objs, 1, 6);
}

const variant = process.argv[3] ?? "outline";
const dest = process.argv[2];
if (!dest) {
  console.error("usage: make-fixture-pdf.mjs <out.pdf> [outline|plain|scanned]");
  process.exit(1);
}
const buf =
  variant === "plain" ? buildOutline({ withOutline: false }) : variant === "scanned" ? buildScanned() : buildOutline({ withOutline: true });
writeFileSync(dest, buf);
console.log(`wrote ${dest} (${buf.length} bytes, ${variant})`);
