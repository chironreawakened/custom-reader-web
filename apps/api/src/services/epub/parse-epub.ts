/**
 * EPUB parser (PLAN slice 2.2, handoff §5.2) — pure, dependency-light:
 * jszip + @xmldom/xmldom, no DB/S3 access. The worker orchestrates storage.
 *
 * Pipeline: unzip → DRM detect → container.xml → OPF (metadata, manifest,
 * spine) → TOC (epub3 nav → NCX → spine+headings fallback) → per-spine-item
 * sanitize + canonical text + asset:<id> placeholder rewrite → image extract.
 */
import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";
import JSZip from "jszip";
import { canonicalText, type CTElement } from "@reader/shared";
import { detectDrm, detectDrmInXml, type DrmHit } from "./detect-drm.js";
import { mapDcLanguage, type DocLanguage } from "./detect-language.js";
import { imageSize, mimeByPath, type ImageSize } from "./image-size.js";
import { sanitizeSection } from "./sanitize.js";

export const PARSER_VERSION = 1;

export interface ParsedAsset {
  id: string; // generated uuid — also used in `asset:<id>` placeholders
  /** Normalized zip path of the source file. */
  path: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  role: "image" | "cover";
  bytes: Uint8Array;
}

export interface ParsedSection {
  idx: number;
  href: string;
  title: string | null;
  /** Sanitized HTML with asset:<id> placeholders. */
  html: string;
  canonicalLength: number;
  wordCount: number;
  /** Canonical text (worker feeds to_tsvector('simple', …) in SQL). */
  canonicalText: string;
}

export interface ParsedTocEntry {
  /** Positional id within the flat list (0-based). */
  idx: number;
  /** Flat index of the parent, or null for root entries. */
  parentIdx: number | null;
  label: string;
  /** Flat index of the section this entry points to, or null. */
  sectionIdx: number | null;
  /** Original href (kept when it does not map to a spine section). */
  href: string | null;
}

export interface ParsedEpub {
  title: string;
  author: string | null;
  dcLanguage: string | null;
  language: DocLanguage | null;
  sections: ParsedSection[];
  toc: ParsedTocEntry[];
  assets: ParsedAsset[];
  coverAssetId: string | null;
  wordCount: number;
}

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubError";
  }
}

// ---------------------------------------------------------------------------
// Zip / path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a section-relative href to a normalized zip path.
 * Returns null when the reference is not a local file (http:, mailto:, …).
 */
export function resolveEpubHref(baseHref: string, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const scheme = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/);
  if (scheme) {
    // Local files only; http(s)/mailto/data/asset references stay as-is.
    return null;
  }
  try {
    const base = new URL("http://epub.local/" + baseHref);
    const u = new URL(trimmed, base);
    const path = decodeURIComponent(u.pathname).replace(/^\//, "");
    return path || null;
  } catch {
    return null;
  }
}

/** Read a file from the zip (public API). Returns null when absent. */
async function readZipFile(zip: JSZip, path: string): Promise<Uint8Array | null> {
  let file = zip.file(path);
  if (!file) {
    // Retry with non-ASCII segments percent-encoded (some producers over-encode).
    const enc = path.replace(/[^\x20-\x7e]/g, (c) => encodeURIComponent(c));
    file = zip.file(enc);
  }
  if (!file || file.dir) return null;
  return new Uint8Array(await file.async("uint8array"));
}

// ---------------------------------------------------------------------------
// Small DOM helpers (namespace-tolerant, xmldom-friendly)
// ---------------------------------------------------------------------------

type AnyNode = {
  nodeType: number;
  nodeName: string;
  childNodes: ArrayLike<AnyNode>;
  // xmldom types textContent as `string | null`; accept both.
  textContent?: string | null;
  getAttribute?: (n: string) => string | null;
};

function tagOf(node: AnyNode): string {
  // xmldom: qualified name (e.g. "dc:title"); match on the local part.
  return node.nodeName.split(":").pop()!.toLowerCase();
}

function* childrenOf(node: AnyNode): Generator<AnyNode> {
  for (let i = 0; i < node.childNodes.length; i++) {
    yield node.childNodes[i]!;
  }
}

function* descendantsOf(node: AnyNode): Generator<AnyNode> {
  for (const child of childrenOf(node)) {
    yield child;
    if (child.nodeType === 1) {
      yield* descendantsOf(child);
    }
  }
}

function attr(node: AnyNode, name: string): string | null {
  try {
    return node.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

function textContent(node: AnyNode): string {
  return (node.textContent ?? "").trim();
}

/** Find <body> in an XHTML document; fall back to the root element. */
function bodyOf(root: AnyNode): AnyNode {
  for (const n of descendantsOf(root)) {
    if (n.nodeType === 1 && tagOf(n) === "body") return n;
  }
  return root;
}

// ---------------------------------------------------------------------------
// container.xml → OPF
// ---------------------------------------------------------------------------

async function findOpfPath(zip: JSZip): Promise<string> {
  const containerBytes = await readZipFile(zip, "META-INF/container.xml");
  if (!containerBytes) throw new EpubError("not an EPUB: missing META-INF/container.xml");
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(containerBytes), "application/xml");
  const root = doc.documentElement;
  if (!root) throw new EpubError("not an EPUB: unreadable container.xml");
  for (const node of descendantsOf(root)) {
    if (node.nodeType === 1 && tagOf(node) === "rootfile") {
      const fullPath = attr(node, "full-path");
      if (fullPath) return fullPath.replace(/^\//, "");
    }
  }
  throw new EpubError("not an EPUB: no rootfile in container.xml");
}

// ---------------------------------------------------------------------------
// OPF parsing
// ---------------------------------------------------------------------------

interface OpfItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
}

interface OpfData {
  title: string | null;
  author: string | null;
  dcLanguage: string | null;
  items: Map<string, OpfItem>;
  spine: string[]; // item ids in reading order
  coverItemId: string | null;
}

function parseOpf(xmlText: string): OpfData {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const root = doc.documentElement;
  if (!root || tagOf(root) !== "package") throw new EpubError("unreadable OPF");

  let title: string | null = null;
  let author: string | null = null;
  let dcLanguage: string | null = null;
  let coverItemId: string | null = null;
  const items = new Map<string, OpfItem>();
  const spine: string[] = [];

  for (const node of descendantsOf(root)) {
    if (node.nodeType !== 1) continue;
    const tag = tagOf(node);
    if (tag === "title" && !title && (!attr(node, "id") || true)) {
      // <dc:title> inside metadata (and plain <title> in some malformed OPFs).
      const t = textContent(node);
      if (t) title = t;
    } else if (tag === "creator" && !author) {
      const t = textContent(node);
      if (t) author = t;
    } else if (tag === "language") {
      const t = textContent(node);
      if (t) dcLanguage = t;
    } else if (tag === "meta") {
      const name = (attr(node, "name") ?? "").toLowerCase();
      if (name === "cover") coverItemId = attr(node, "content");
    } else if (tag === "item") {
      const id = attr(node, "id");
      const href = attr(node, "href");
      if (!id || !href) continue;
      items.set(id, {
        id,
        href,
        mediaType: (attr(node, "media-type") ?? "application/octet-stream").toLowerCase(),
        properties: (attr(node, "properties") ?? "").split(/\s+/).filter(Boolean),
      });
    } else if (tag === "itemref") {
      const idref = attr(node, "idref");
      if (idref) spine.push(idref);
    }
  }
  // epub3: <meta properties="cover-image" id="...">
  if (!coverItemId) {
    for (const node of descendantsOf(root)) {
      if (node.nodeType === 1 && tagOf(node) === "meta") {
        const props = (attr(node, "properties") ?? "").split(/\s+/);
        if (props.includes("cover-image")) coverItemId = attr(node, "id");
      }
    }
  }

  return { title, author, dcLanguage, items, spine, coverItemId };
}

// ---------------------------------------------------------------------------
// TOC: epub3 nav → NCX → fallback
// ---------------------------------------------------------------------------

interface NavPoint {
  label: string;
  href: string | null;
  children: NavPoint[];
}

function flattenNav(points: NavPoint[], parentIdx: number | null, sectionByHref: Map<string, number>, out: ParsedTocEntry[]): void {
  for (const p of points) {
    const idx = out.length;
    out.push({
      idx,
      parentIdx,
      label: p.label || "(untitled)",
      sectionIdx: p.href != null ? (sectionByHref.get(p.href) ?? null) : null,
      href: p.href,
    });
    if (p.children.length) flattenNav(p.children, idx, sectionByHref, out);
  }
}

async function parseNavToc(zip: JSZip, opf: OpfData, sectionByHref: Map<string, number>): Promise<ParsedTocEntry[] | null> {
  // Locate the toc nav document from the manifest.
  let navItem: OpfItem | null = null;
  for (const item of opf.items.values()) {
    const props = item.properties;
    if (
      item.mediaType === "application/xhtml+xml" &&
      (props.includes("nav") || props.some((p) => p === "nav"))
    ) {
      navItem = item;
      break;
    }
  }
  // Fallback: any manifest item with properties "nav".
  if (!navItem) {
    for (const item of opf.items.values()) {
      if (item.properties.includes("nav")) {
        navItem = item;
        break;
      }
    }
  }
  if (!navItem) return null;
  const bytes = await readZipFile(zip, navItem.href);
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xhtml+xml");
  const root = doc.documentElement;
  if (!root) return null;

  // Find <nav epub:type="toc">, else the first <nav>.
  let nav: AnyNode | null = null;
  for (const n of descendantsOf(root)) {
    if (n.nodeType === 1 && tagOf(n) === "nav") {
      const types = (attr(n, "epub:type") ?? attr(n, "type") ?? "").split(/\s+/);
      if (types.includes("toc")) {
        nav = n;
        break;
      }
      if (!nav) nav = n;
    }
  }
  if (!nav) return null;

  const points: NavPoint[] = [];
  function collectLinks(node: AnyNode, container: NavPoint[] | null) {
    for (const child of childrenOf(node)) {
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (tag === "a" && attr(child, "href")) {
        const label = textContent(child);
        // Look ahead: does this <a> contain a nested <ul>/<ol> (sub-items)?
        const sub: NavPoint[] = [];
        const point: NavPoint = { label, href: attr(child, "href"), children: sub };
        (container ?? points).push(point);
        for (const c of childrenOf(child)) {
          if (c.nodeType === 1 && (tagOf(c) === "ul" || tagOf(c) === "ol" || tagOf(c) === "ol")) {
            collectLinks(c, sub);
          }
        }
      } else if (tag === "ul" || tag === "ol" || tag === "li" || tag === "div") {
        collectLinks(child, container);
      }
    }
  }
  collectLinks(nav, null);
  if (points.length === 0) return null;

  const out: ParsedTocEntry[] = [];
  flattenNav(points, null, sectionByHref, out);
  return out;
}

async function parseNcxToc(zip: JSZip, opf: OpfData, sectionByHref: Map<string, number>): Promise<ParsedTocEntry[] | null> {
  // NCX is referenced from OPF spine's toc attribute or by media-type.
  let ncxItem: OpfItem | null = null;
  for (const item of opf.items.values()) {
    if (item.mediaType === "application/x-dtbncx+xml") {
      ncxItem = item;
      break;
    }
  }
  if (!ncxItem) return null;
  const bytes = await readZipFile(zip, ncxItem.href);
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  const root = doc.documentElement;
  if (!root || tagOf(root) !== "ncx") return null;

  const points: NavPoint[] = [];
  function walkNavPoints(node: AnyNode, container: NavPoint[] | null) {
    for (const child of childrenOf(node)) {
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (tag === "navpoint") {
        const point: NavPoint = { label: "", href: null, children: [] };
        for (const c of childrenOf(child)) {
          if (c.nodeType !== 1) continue;
          const t = tagOf(c);
          if (t === "navlabel") {
            for (const tl of descendantsOf(c)) {
              if (tl.nodeType === 1 && tagOf(tl) === "text") {
                point.label = textContent(tl);
                break;
              }
            }
          } else if (t === "content") {
            point.href = attr(c, "src");
          } else if (t === "navpoint") {
            walkNavPoints(c, point.children);
          }
        }
        (container ?? points).push(point);
      }
    }
  }
  for (const node of descendantsOf(root)) {
    if (node.nodeType === 1 && tagOf(node) === "navmap") {
      walkNavPoints(node, null);
      break;
    }
  }
  if (points.length === 0) return null;

  const out: ParsedTocEntry[] = [];
  flattenNav(points, null, sectionByHref, out);
  return out;
}

/** Fallback TOC: one entry per spine section, label from the first heading. */
function fallbackToc(sections: ParsedSection[]): ParsedTocEntry[] {
  return sections.map((s, i) => ({
    idx: i,
    parentIdx: null,
    label: s.title ?? `Section ${i + 1}`,
    sectionIdx: i,
    href: s.href,
  }));
}

// ---------------------------------------------------------------------------
// Section processing
// ---------------------------------------------------------------------------

const XHTML_MEDIA = new Set(["application/xhtml+xml", "text/html"]);

function firstHeading(root: AnyNode): string | null {
  for (const node of descendantsOf(root)) {
    if (node.nodeType !== 1) continue;
    const t = tagOf(node);
    if (/^h[1-6]$/.test(t)) {
      const text = textContent(node);
      if (text) return text.slice(0, 200);
    }
  }
  return null;
}

interface SectionContext {
  zip: JSZip;
  /** href (normalized zip path) → generated asset id. */
  assetByPath: Map<string, string>;
  sectionDir: string;
}

/**
 * Sanitize one spine document, rewrite local image refs to asset:<id>,
 * and compute canonical text.
 */
function processSection(sectionHref: string, raw: Uint8Array, ctx: SectionContext): {
  html: string;
  canonicalText: string;
  title: string | null;
  referencedImages: Set<string>;
} {
  const text = new TextDecoder().decode(raw);
  const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
  const root = doc.documentElement as AnyNode | null;
  if (!root) {
    // Unparseable XHTML — degrade gracefully: keep nothing, title from path.
    return { html: "", canonicalText: "", title: null, referencedImages: new Set() };
  }
  const body = bodyOf(root);

  // 1. Collect + rewrite image references.
  const referencedImages = new Set<string>();
  const rewrite = (node: AnyNode) => {
    for (const child of childrenOf(node)) {
      if (child.nodeType !== 1) continue;
      const t = tagOf(child);
      if (t === "img" || t === "source") {
        const src = attr(child, "src");
        if (src) {
          const resolved = resolveEpubHref(sectionHref, src);
          if (resolved && ctx.zip.file(resolved) && !ctx.zip.file(resolved)!.dir) {
            referencedImages.add(resolved);
            let id = ctx.assetByPath.get(resolved);
            if (!id) {
              id = crypto.randomUUID();
              ctx.assetByPath.set(resolved, id);
            }
            (child as { setAttribute?: (k: string, v: string) => void }).setAttribute?.("src", `asset:${id}`);
          }
        }
      }
      rewrite(child);
    }
  };
  rewrite(body);

  // 2. Serialize → sanitize.
  const serialized = new XMLSerializer().serializeToString(body as unknown as XmlElement);
  const html = sanitizeSection(serialized);

  // 3. Canonical text from the (unsanitized) parsed tree — sanitizing does
  //    not change text content, and the parsed tree is what we can walk.
  const canonRoot = body as unknown as CTElement;
  const { text: canonical } = canonicalText(canonRoot);
  const title = firstHeading(body) ?? null;

  return { html, canonicalText: canonical, title, referencedImages };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ParseEpubResult {
  epub: ParsedEpub;
  drm: DrmHit | null;
}

export async function parseEpub(buffer: Uint8Array): Promise<ParseEpubResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new EpubError("file is not a valid EPUB (cannot open zip)");
  }

  // DRM detection first (cheap, over file paths).
  const drm = detectDrm(zip);
  if (drm) return { epub: emptyEpub(), drm };

  const opfPath = await findOpfPath(zip);
  const opfBytes = await readZipFile(zip, opfPath);
  if (!opfBytes) throw new EpubError(`OPF not found at ${opfPath}`);
  const opfText = new TextDecoder().decode(opfBytes);
  if (detectDrmInXml(opfText)) {
    return { epub: emptyEpub(), drm: { reason: "DRM metadata detected in OPF", where: opfPath } };
  }
  const opf = parseOpf(opfText);
  if (opf.spine.length === 0) throw new EpubError("EPUB has an empty spine (no readable sections)");

  // Cover item (by manifest properties / <meta name="cover">).
  const coverItem = opf.coverItemId ? opf.items.get(opf.coverItemId) : null;
  let coverPath: string | null = null;
  if (coverItem) {
    const p = resolveEpubHref(opfPath, coverItem.href);
    if (p && zip.file(p)) coverPath = p;
  }

  // asset:<id> placeholder ids — cover first so it has a stable id.
  const assetByPath = new Map<string, string>();
  const assets: ParsedAsset[] = [];
  const reserveAsset = (path: string, role: "image" | "cover"): string => {
    let id = assetByPath.get(path);
    if (!id) {
      id = crypto.randomUUID();
      assetByPath.set(path, id);
    }
    return id;
  };

  const ctx: SectionContext = { zip, assetByPath, sectionDir: "" };

  const sections: ParsedSection[] = [];
  const sectionByHref = new Map<string, number>();
  const referencedImages = new Set<string>();

  let idx = 0;
  for (const idref of opf.spine) {
    const item = opf.items.get(idref);
    if (!item) continue;
    if (!XHTML_MEDIA.has(item.mediaType)) continue; // skip audio/video/fonts in spine
    const sectionHref = resolveEpubHref(opfPath, item.href);
    if (!sectionHref) continue;
    const raw = await readZipFile(zip, sectionHref);
    if (!raw) continue; // missing spine document — skip
    const { html, canonicalText: canon, title, referencedImages: imgs } = processSection(sectionHref, raw, {
      ...ctx,
      sectionDir: dirOf(sectionHref),
    });
    for (const p of imgs) referencedImages.add(p);
    const words = canon.length ? canon.split(/\s+/).filter(Boolean).length : 0;
    sections.push({
      idx: idx++,
      href: sectionHref,
      title,
      html,
      canonicalLength: canon.length,
      wordCount: words,
      canonicalText: canon,
    });
    sectionByHref.set(sectionHref, sections.length - 1);
  }
  if (sections.length === 0) throw new EpubError("EPUB spine contains no readable XHTML sections");

  // Collect referenced images + cover.
  if (coverPath) referencedImages.add(coverPath);
  for (const path of referencedImages) {
    const bytes = await readZipFile(zip, path);
    if (!bytes) continue;
    const id = reserveAsset(path, path === coverPath ? "cover" : "image");
    const size = imageSize(bytes);
    assets.push({
      id,
      path,
      mime: mimeByPath(path),
      size: bytes.length,
      width: size ? size.width : null,
      height: size ? size.height : null,
      role: path === coverPath ? "cover" : "image",
      bytes,
    });
  }

  // TOC: nav → NCX → fallback.
  const toc = (await parseNavToc(zip, opf, sectionByHref)) ?? (await parseNcxToc(zip, opf, sectionByHref)) ?? fallbackToc(sections);

  const wordCount = sections.reduce((sum, s) => sum + s.wordCount, 0);
  const epub: ParsedEpub = {
    title: opf.title || opfPath,
    author: opf.author,
    dcLanguage: opf.dcLanguage,
    language: mapDcLanguage(opf.dcLanguage),
    sections,
    toc,
    assets,
    coverAssetId: coverPath ? (assetByPath.get(coverPath) ?? null) : null,
    wordCount,
  };
  return { epub, drm: null };
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i + 1) : "";
}

function emptyEpub(): ParsedEpub {
  return {
    title: "",
    author: null,
    dcLanguage: null,
    language: null,
    sections: [],
    toc: [],
    assets: [],
    coverAssetId: null,
    wordCount: 0,
  };
}
