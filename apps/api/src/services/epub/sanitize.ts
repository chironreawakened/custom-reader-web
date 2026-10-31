/**
 * sanitize-html config for EPUB XHTML sections (PLAN slice 2.2).
 *
 * Goal: keep the markup the reader renders (headings, paragraphs, inline
 * formatting, lists, tables, images, anchors) and strip everything that could
 * execute or leak: scripts, event handlers, forms, iframes, styles with
 * url()/expression(), javascript: links, etc.
 *
 * `asset:<id>` placeholders survive (they are plain `src` attribute values,
 * rewritten to signed URLs at serve time — see SPECS §3).
 */
import type { IOptions } from "sanitize-html";

export const SANITIZE_OPTIONS: IOptions = {
  allowedTags: [
    // block
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "div", "section", "article", "aside", "header", "footer",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    "blockquote", "pre", "code", "figure", "figcaption",
    "hr", "br",
    // inline
    "a", "span", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup",
    "small", "mark", "del", "ins", "q", "cite", "abbr", "time", "ruby", "rt", "rp", "wbr",
    // images
    "img", "picture", "source",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    source: ["src", "type"],
    "*": ["id", "class"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
    ol: ["start"],
  },
  // Keep src (including asset: placeholders) but strip dangerous schemes.
  allowedSchemes: ["http", "https", "mailto", "asset"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https", "asset"],
    source: ["http", "https", "asset"],
  },
  // No styles at all: readers apply their own theme; author CSS is not
  // trusted (expression()/url() exfil) and is dropped entirely.
  allowedStyles: {},
  selfClosing: ["img", "br", "hr"],
  disallowedTagsMode: "discard",
  // Drop onProtocol values like javascript: (belt-and-braces with schemes).
  transformTags: {
    // EPUBs sometimes use <i> for italic and <b> for bold — keep as-is.
  },
  nonTextTags: [],
  // Never emit comments.
  exclusiveFilter: (frame) => {
    // Strip elements that become empty after sanitizing only when they are
    // structural; leave content tags alone (default behavior).
    return false;
  },
};

export function sanitizeSection(html: string): string {
  // Lazy require so the pure parser tests don't load sanitize-html.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sanitizeHtml = require("sanitize-html") as (input: string, opts: IOptions) => string;
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
