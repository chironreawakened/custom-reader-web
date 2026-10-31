/**
 * Parameterized minimal-EPUB builder for unit tests and e2e.
 *
 * Produces a small valid EPUB 3 book (container + OPF + spine + optional
 * nav/NCX TOC + optional images + optional cover) from a plain spec. Uses
 * JSZip (already an apps/api dependency) — no hand-rolled zip writer.
 */
import JSZip from "jszip";

export interface FixtureSpineItem {
  id: string;
  href: string;
  html: string;
}

export interface FixtureSpec {
  title: string;
  author: string | null;
  /** BCP-47; null omits the element entirely. */
  language: string | null;
  spine: FixtureSpineItem[];
  /** null/undefined → no nav, no NCX (spine-derived fallback TOC). */
  toc?: { label: string; href: string }[] | null;
  /** Build a legacy NCX toc as well (default false). */
  ncx?: boolean;
  /** Additional zip-path → bytes image files referenced from section HTML. */
  images?: Record<string, Uint8Array>;
  /** Manifest id of the cover item; requires a matching image. */
  cover?: string;
  /** href of the cover image within the OPF directory (default "cover.png"). */
  coverHref?: string;
}

const xhtml = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escapeXml(
    body.replace(/<[^>]*>/g, "").slice(0, 40) || "section",
  )}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build the fixture EPUB as bytes. */
export async function buildFixtureEpub(spec: FixtureSpec): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  const tocLines = (spec.toc ?? [])
    .map((t) => `      <li><a href="${escapeXml(t.href)}">${escapeXml(t.label)}</a></li>`)
    .join("\n");
  const nav = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n<head><title>Contents</title></head>\n<body>\n  <nav epub:type="toc" id="toc">\n    <ol>\n${tocLines}\n    </ol>\n  </nav>\n</body>\n</html>\n`;

  const hasCover = Boolean(spec.cover) && Boolean(spec.images?.[spec.coverHref ?? "cover.png"]);
  const coverHref = spec.coverHref ?? "cover.png";

  const manifestItems: string[] = [];
  for (const item of spec.spine) {
    manifestItems.push(`<item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`);
  }
  if (spec.toc) {
    manifestItems.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  }
  if (spec.ncx) {
    manifestItems.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  }
  for (const [path, bytes] of Object.entries(spec.images ?? {})) {
    const rel = path.startsWith("img/") ? path.slice(4) : path;
    const id = path === coverHref && spec.cover ? spec.cover : `img-${rel.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const coverProps = spec.cover === id ? ' properties="cover-image"' : "";
    manifestItems.push(`<item id="${id}" href="${rel}" media-type="image/png"${coverProps}/>`);
    zip.file(`OEBPS/${rel}`, bytes);
  }

  const languageLine = spec.language ? `\n    <dc:language>${escapeXml(spec.language)}</dc:language>` : "";
  const coverMeta = spec.cover ? `\n    <meta name="cover" content="${spec.cover}"/>` : "";
  const ncxMeta = spec.ncx
    ? `\n    <meta name="ncx" content="ncx"/>`
    : "";

  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:identifier id="uid">urn:uuid:11111111-2222-3333-4444-555555555555</dc:identifier>\n    <dc:title>${escapeXml(spec.title)}</dc:title>${
    spec.author ? `\n    <dc:creator>${escapeXml(spec.author)}</dc:creator>` : ""
  }${languageLine}${coverMeta}${ncxMeta}\n  </metadata>\n  <manifest>\n${manifestItems.join("\n    ")}\n  </manifest>\n  <spine${spec.ncx ? ' toc="ncx"' : ""}>\n${spec.spine
    .map((s) => `    <itemref idref="${s.id}"/>`)
    .join("\n")}\n  </spine>\n</package>\n`;

  const spineHtmls = spec.spine.map((s) => xhtml(s.html));
  zip.file("META-INF/container.xml", containerXml());
  zip.file("OEBPS/content.opf", opf);
  spec.spine.forEach((s, i) => zip.file(`OEBPS/${s.href}`, spineHtmls[i]!));
  if (spec.toc) zip.file("OEBPS/nav.xhtml", nav);
  if (spec.ncx) zip.file("OEBPS/toc.ncx", ncxXml(spec));

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function containerXml(): string {
  return `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n`;
}

function ncxXml(spec: FixtureSpec): string {
  const pts = (spec.toc ?? [])
    .map((t, i) => `    <navPoint id="np${i}" playOrder="${i + 1}">\n      <navLabel><text>${escapeXml(t.label)}</text></navLabel>\n      <content src="${t.href}"/>\n    </navPoint>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head>\n    <meta name="dtb:uid" content="urn:uuid:11111111-2222-3333-4444-555555555555"/>\n  </head>\n  <docTitle><text>${escapeXml(spec.title)}</text></docTitle>\n  <navMap>\n${pts}\n  </navMap>\n</ncx>\n`;
}
