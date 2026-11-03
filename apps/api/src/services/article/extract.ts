/**
 * Slice 5 article ingest (PLAN "URL articles"): HTML bytes → Readability
 * extraction → sanitized section + re-hosted images.
 *
 * The pure, testable core is {@link extractArticle}: HTML string + final URL
 * → extracted content, a sanitized section (asset:<id> placeholders) and the
 * image list (absolute URLs, in document order). Fetching and image download
 * live in the worker, which feeds each image through `rewriteImg` and gets
 * back the asset id to store.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { canonicalText, type CTElement } from "@reader/shared";
import { sanitizeSection } from "../epub/sanitize.js";
import { mapDcLanguage } from "../epub/detect-language.js";

/** The parser version stamped on article documents. */
export const ARTICLE_PARSER_VERSION = 1;

/** Below this the page is not a readable article (nav junk, 404 shells…). */
const MIN_WORDS = 25;

export interface ExtractedImage {
  /** Absolute URL of the image as published. */
  url: string;
  alt: string | null;
}

export interface ArticleContent {
  title: string;
  byline: string | null;
  /** BCP-47 from <html lang>/meta, mapped to the reader's three languages. */
  language: "english" | "finnish" | "simple" | null;
  /** Sanitized article HTML (asset:<id> placeholders already in). */
  html: string;
  /** Canonical text of the stored HTML — tsvector + anchoring base. */
  canonicalText: string;
  wordCount: number;
  /** Unique image refs (absolute, http/https) in document order. */
  images: ExtractedImage[];
}

export class ArticleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleError";
  }
}

function isHttpUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

type ParsedDoc = ReturnType<typeof parseHTML>;

function langOf(doc: ParsedDoc): string | null {
  const fromHtml = doc.documentElement?.getAttribute("lang");
  if (fromHtml) return fromHtml;
  const meta = doc.querySelector("meta[name='language'], meta[property='og:locale']");
  return meta?.getAttribute("content") ?? null;
}

/**
 * linkedom quirk: parseHTML(FRAGMENT) leaves body empty and puts the content
 * on documentElement; full documents land in body. Pick the right container.
 */
function rootOf(doc: ParsedDoc): { childNodes: ArrayLike<{ outerHTML?: string }> } {
  if (doc.body && doc.body.childNodes.length > 0) return doc.body;
  return doc.documentElement;
}

/**
 * Extract article content from a raw fetched HTML document.
 *
 * @param html       raw document bytes, decoded
 * @param baseUrl    final URL after redirects (resolves relative srcs)
 * @param rewriteImg called once per unique image in the article content.
 *                   The worker downloads + encrypts + stores the bytes and
 *                   returns the asset id, or null to keep the original src
 *                   (the image then simply does not render — no crash).
 */
export async function extractArticle(
  html: string,
  baseUrl: string,
  rewriteImg: (img: ExtractedImage) => Promise<string | null>,
): Promise<ArticleContent> {
  const { window } = parseHTML(html);
  const doc = window.document;

  // Readability mutates the document it parses — so parse, then work on the
  // serialized content it produces.
  const article = new Readability(doc).parse();
  if (!article || !(article.textContent ?? "").trim()) {
    throw new ArticleError("no readable article content at this URL");
  }
  const title = (article.title || "").trim() || "Untitled article";
  const byline = (article.byline || "").trim() || null;
  const language = mapDcLanguage(langOf(doc));

  // Re-parse the extracted content so we can walk + rewrite it.
  const { window: w2 } = parseHTML(article.content ?? "");
  const root = rootOf(w2.document);

  // --- images: collect (deduped, in document order) from the content tree ---
  const images: ExtractedImage[] = [];
  const byUrl = new Map<string, ExtractedImage>();
  for (const el of w2.document.querySelectorAll("img, source")) {
    const src = el.getAttribute("src");
    if (!src) continue;
    let abs: string;
    try {
      abs = new URL(src, baseUrl).toString();
    } catch {
      continue;
    }
    if (!isHttpUrl(abs) || byUrl.has(abs)) continue;
    const img: ExtractedImage = { url: abs, alt: (el.getAttribute("alt") ?? "").trim() || null };
    images.push(img);
    byUrl.set(abs, img);
  }

  // Download + rewrite: src → asset:<id> when the worker got the bytes.
  for (const img of images) {
    const id = await rewriteImg(img);
    if (!id) continue;
    for (const el of w2.document.querySelectorAll("img, source")) {
      const s = el.getAttribute("src");
      if (s && safeResolve(s, baseUrl) === img.url) el.setAttribute("src", `asset:${id}`);
    }
  }

  // Serialize the content (its children) and sanitize like epub sections.
  let serialized = "";
  const kids = root.childNodes;
  for (let i = 0; i < kids.length; i++) serialized += (kids[i] as { outerHTML?: string }).outerHTML ?? "";
  const htmlOut = sanitizeSection(serialized);

  // Canonical text from the SANITIZED output — anchors must line up with the
  // HTML the reader renders, and sanitizing can drop tags.
  const { window: w3 } = parseHTML(`<div id="c">${htmlOut}</div>`);
  const canonRoot = w3.document.getElementById("c") as unknown as CTElement;
  const { text: canonical } = canonicalText(canonRoot);
  const wordCount = canonical.length ? canonical.split(/\s+/).filter(Boolean).length : 0;
  if (wordCount < MIN_WORDS) {
    throw new ArticleError("the page has no substantial article text");
  }

  return { title, byline, language, html: htmlOut, canonicalText: canonical, wordCount, images };
}

function safeResolve(src: string, base: string): string | null {
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}
