/**
 * Slice 6 PDF parsing (worker side, PLAN slice 6, SPECS §2/§7).
 *
 * The faithful mode renders the ORIGINAL bytes in the browser with pdf.js
 * (range requests), so the worker never rasterizes. Its job is lighter than
 * the epub path: open the PDF once, read the outline (→ toc_entries with
 * page destinations), the page count and basic metadata, and flag whether
 * a text layer exists at all — a scanned PDF (no text) gets a clear
 * message, no highlights (SPECS §2 "PDF").
 *
 * pdfjs-dist is kept EXTERNAL in the esbuild build: the module resolves from
 * node_modules at runtime, so pdf.js's default worker-file lookup (relative
 * to the package's own pdf.mjs) points at the real pdf.worker.mjs. node_modules
 * ships with the image (the build tree is copied wholesale; the other
 * externals depend on it too).
 */
import { getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

export const PDF_PARSER_VERSION = 1;

/** Parsed outline entry, ready for toc_entries. */
export interface PdfOutlineEntry {
  /** 1-based outline position (flat, DFS order). */
  idx: number;
  parentId: number | null;
  label: string;
  /** 1-based destination page, null when undeterminable. */
  page: number | null;
}

export interface PdfParseResult {
  title: string | null;
  author: string | null;
  pageCount: number;
  outline: PdfOutlineEntry[];
  /** false when no page has any extractable text (scanned). */
  hasText: boolean;
  wordCount: number | null;
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

/**
 * Open a PDF buffer and read its outline + metadata. The document is
 * closed before the promise settles; the buffer is never retained.
 */
export async function parsePdf(buffer: Uint8Array): Promise<PdfParseResult> {
  let doc;
  try {
    doc = await getDocument({ data: buffer }).promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg) || (e as { name?: string }).name === "PasswordException") {
      throw new PdfError("the PDF is password-protected; it cannot be opened");
    }
    if (/Invalid PDF structure|file is not a valid PDF|missing magic/i.test(msg)) {
      throw new PdfError("the file is not a readable PDF");
    }
    throw new PdfError(`the PDF could not be opened: ${msg}`);
  }

  try {
    const pageCount = doc.numPages;
    if (pageCount === 0) throw new PdfError("the PDF has no pages");

    const [meta, outline] = await Promise.all([doc.getMetadata(), doc.getOutline()]);
    const info = (meta.info ?? {}) as Record<string, unknown>;
    const title = toText(info.Title);
    const author = toText(info.Author);

    const flat = outline ? await flattenOutline(outline, doc) : [];
    const { hasText, wordCount } = await probeText(doc);

    return {
      title: title || null,
      author: author || null,
      pageCount,
      outline: flat,
      hasText,
      wordCount,
    };
  } finally {
    // Release the page cache + decoded data; the doc proxy is dropped.
    await doc.cleanup().catch(() => {});
  }
}

function toText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Flatten the outline tree (DFS) and resolve each destination to a 1-based
 * page. Destinations are either a named string (looked up via
 * `getDestination`) or a direct array whose first element is a page ref.
 * External links (url) and unresolvable destinations get page null — they
 * still appear in the TOC, just not clickable (SPECS: the outline IS the
 * TOC, degrading gracefully).
 */
async function flattenOutline(nodes: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>, doc: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  const out: PdfOutlineEntry[] = [];
  let idx = 0;

  const walk = async (node: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number], parentId: number | null): Promise<void> => {
    idx += 1;
    const entry: PdfOutlineEntry = { idx, parentId, label: node.title || "(untitled)", page: null };
    try {
      entry.page = await destPage(node, doc);
    } catch {
      entry.page = null;
    }
    out.push(entry);
    for (const child of node.items ?? []) {
      await walk(child, idx);
    }
  };

  for (const n of nodes) await walk(n, null);
  return out;
}

type OutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

async function destPage(node: OutlineNode, doc: PDFDocumentProxy): Promise<number | null> {
  let dest: Array<unknown> | null;
  if (typeof node.dest === "string") {
    dest = await doc.getDestination(node.dest);
  } else if (Array.isArray(node.dest)) {
    dest = node.dest;
  } else {
    return null;
  }
  if (!dest || dest.length === 0) return null;
  const first = dest[0];
  const pageRef = typeof first === "object" && first !== null ? first : null;
  if (!pageRef) return null; // e.g. a Fit-only dest without a page
  const pageIdx = await doc.getPageIndex(pageRef as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
  return pageIdx >= 0 ? pageIdx + 1 : null;
}

/**
 * Text-layer probe (SPECS §2 "scanned PDFs with no text layer get a clear
 * message"): check a sample of pages. Word count comes from the same
 * sample scaled up — a good-enough number for the library list; the exact
 * count is not worth extracting every page of a 300-page book for.
 */
async function probeText(doc: PDFDocumentProxy): Promise<{ hasText: boolean; wordCount: number | null }> {
  const n = doc.numPages;
  // Sample up to 5 pages, spread across the document.
  const sample = n <= 5 ? Array.from({ length: n }, (_, i) => i + 1) : [1, Math.ceil(n / 4), Math.ceil(n / 2), Math.ceil((3 * n) / 4), n];
  let totalChars = 0;
  let pagesWithText = 0;
  for (const p of sample) {
    try {
      const page: PDFPageProxy = await doc.getPage(p);
      const content = await page.getTextContent();
      let chars = 0;
      for (const it of content.items) {
        if ("str" in it) chars += it.str.length; // skip marked-content items
      }
      if (chars > 0) pagesWithText += 1;
      totalChars += chars;
    } catch {
      // A single unreadable page does not fail the whole ingest.
    }
  }
  const hasText = pagesWithText > 0;
  let wordCount: number | null = null;
  if (hasText) {
    // Rough: ~4.5 chars per word; scale the sample to the whole document.
    wordCount = Math.round((totalChars / 4.5) * (n / sample.length));
  }
  return { hasText, wordCount };
}
