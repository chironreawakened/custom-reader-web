/**
 * Slice 4 highlight anchors (SPECS §7) — implemented once, pure TS, shared by
 * the API and the web client (also the future RN client).
 *
 * A `ReflowAnchor` points into a section's CANONICAL text (SPECS §6), never
 * into its raw HTML: the section's DOM may reflow, but the canonical text is
 * the stable coordinate system. Resolution (SPECS §7, in order):
 *   1. `exact` found at `offsetHint` with matching prefix/suffix → use it.
 *   2. All occurrences of `exact` → score by prefix match + suffix match −
 *      distance from the hint → best, if the score is positive.
 *   3. Fuzzy match (diff-match-patch `match_main`, threshold 0.3) around the
 *      hint (content edited after the highlight was saved).
 *   4. Otherwise **orphaned**: still shown in the highlights list, never
 *      dropped, just not drawn in the text.
 *
 * `buildReflowAnchor` is the inverse direction: a client selection expressed
 * as canonical offsets → an anchor ready for storage.
 *
 * Pure on purpose: unit-tested here with golden files, and reused verbatim by
 * the API (export orphan check) and the web (render + selection).
 */
import DiffMatchPatch from "diff-match-patch";
import { z } from "zod";
import { CANONICAL_TEXT_VERSION } from "./canonical-text.js";

// ---------------------------------------------------------------------------
// Anchor types (SPECS §7)
// ---------------------------------------------------------------------------

/** Up to this many canonical chars of context before/after `exact`. */
export const ANCHOR_CONTEXT_CHARS = 32;

export interface ReflowAnchor {
  kind: "reflow";
  v: 1;
  sectionId: string;
  /** Canonical text of the selection. May span blocks (then contains "\n"). */
  exact: string;
  /** Canonical text immediately before the selection, ≤ 32 chars. */
  prefix: string;
  /** Canonical text immediately after the selection, ≤ 32 chars. */
  suffix: string;
  /** Start offset of `exact` in the canonical text (UTF-16 code units). */
  offsetHint: number;
  /** CANONICAL_TEXT_VERSION of the text the anchor was built from. */
  canonicalTextVersion: number;
}

export interface PdfAnchor {
  kind: "pdf";
  v: 1;
  /** 1-based page. */
  page: number;
  exact: string;
  prefix: string;
  suffix: string;
  /** Offset in that page's text-layer string. */
  offsetHint: number;
}

export type HighlightAnchor = ReflowAnchor | PdfAnchor;

// ---------------------------------------------------------------------------
// Validation (zod — source of the OpenAPI spec, slice 10)
// ---------------------------------------------------------------------------

export const reflowAnchor = z
  .object({
    kind: z.literal("reflow"),
    v: z.literal(1),
    sectionId: z.string().uuid(),
    exact: z.string().min(1).max(10_000),
    prefix: z.string().max(ANCHOR_CONTEXT_CHARS).default(""),
    suffix: z.string().max(ANCHOR_CONTEXT_CHARS).default(""),
    offsetHint: z.number().int().min(0),
    canonicalTextVersion: z.number().int().min(1),
  })
  .strict();
export type ReflowAnchorInput = z.infer<typeof reflowAnchor>;

export const pdfAnchor = z
  .object({
    kind: z.literal("pdf"),
    v: z.literal(1),
    page: z.number().int().min(1),
    exact: z.string().min(1).max(10_000),
    prefix: z.string().max(ANCHOR_CONTEXT_CHARS).default(""),
    suffix: z.string().max(ANCHOR_CONTEXT_CHARS).default(""),
    offsetHint: z.number().int().min(0),
  })
  .strict();
export type PdfAnchorInput = z.infer<typeof pdfAnchor>;

export const highlightAnchor = z.discriminatedUnion("kind", [reflowAnchor, pdfAnchor]);
export type HighlightAnchorInput = z.infer<typeof highlightAnchor>;

/**
 * The two anchor kinds carry the same four fields that drive resolution;
 * the ladder (steps 1–4) is identical for both (SPECS §7), so it operates
 * on this common shape.
 */
interface ResolvableAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  offsetHint: number;
}

// ---------------------------------------------------------------------------
// PDF page text (shared: the anchor's coordinate system, SPECS §7)
// ---------------------------------------------------------------------------

/**
 * One text-layer item, in the order the page returns them (pdf.js
 * `TextItem` has `str` + `hasEOL`; marked-content items carry neither and
 * are ignored).
 */
export interface PdfPageTextItem {
  str: string;
  hasEOL?: boolean;
}

/**
 * The page's text-layer string: items in reading order, a "\n" after every
 * item with hasEOL. Both buildPdfAnchor and resolvePdfAnchor work in this
 * string (SPECS §7: offsetHint is "offset in that page's text-layer
 * string"), so the web client must build it with this exact rule.
 */
export function pdfPageText(items: PdfPageTextItem[]): string {
  let s = "";
  for (const it of items) {
    s += it.str;
    if (it.hasEOL) s += "\n";
  }
  return s;
}

// ---------------------------------------------------------------------------
// Building (client: selection → anchor)
// ---------------------------------------------------------------------------

export interface CanonicalSelection {
  /** Offset in the canonical text where the selection starts. */
  start: number;
  /** Offset in the canonical text where the selection ends (exclusive). */
  end: number;
}

function contextBefore(text: string, end: number): string {
  const s = Math.max(0, end - ANCHOR_CONTEXT_CHARS);
  return text.slice(s, end);
}

function contextAfter(text: string, start: number): string {
  const e = Math.min(text.length, start + ANCHOR_CONTEXT_CHARS);
  return text.slice(start, e);
}

/**
 * Build a storable PdfAnchor from a selection expressed as offsets in the
 * 1-based page's text-layer string (the concatenation of that page's text
 * items, in reading order — the same string the client reads back at
 * render time, SPECS §7).
 */
export function buildPdfAnchor(
  page: number,
  sel: CanonicalSelection,
  text: string,
): PdfAnchor {
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    throw new Error("buildPdfAnchor: page must be a positive integer");
  }
  if (typeof sel.start !== "number" || typeof sel.end !== "number") {
    throw new Error("buildPdfAnchor: start/end must be numbers");
  }
  if (sel.start < 0 || sel.end > text.length || sel.end <= sel.start) {
    throw new Error("buildPdfAnchor: empty or out-of-range selection");
  }
  return {
    kind: "pdf",
    v: 1,
    page,
    exact: text.slice(sel.start, sel.end),
    prefix: contextBefore(text, sel.start),
    suffix: contextAfter(text, sel.end),
    offsetHint: sel.start,
  };
}

/**
 * Build a storable ReflowAnchor from a selection expressed as canonical
 * offsets. The client computes the offsets with the `map` of
 * `canonicalText(sectionHtml)` (SPECS §6).
 */
export function buildReflowAnchor(
  sectionId: string,
  sel: CanonicalSelection,
  text: string,
): ReflowAnchor {
  if (typeof sel.start !== "number" || typeof sel.end !== "number") {
    throw new Error("buildReflowAnchor: start/end must be numbers");
  }
  if (sel.start < 0 || sel.end > text.length || sel.end <= sel.start) {
    throw new Error("buildReflowAnchor: empty or out-of-range selection");
  }
  return {
    kind: "reflow",
    v: 1,
    sectionId,
    exact: text.slice(sel.start, sel.end),
    prefix: contextBefore(text, sel.start),
    suffix: contextAfter(text, sel.end),
    offsetHint: sel.start,
    canonicalTextVersion: CANONICAL_TEXT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Resolving (anchor → canonical range, or orphaned)
// ---------------------------------------------------------------------------

/** A resolved anchor is a half-open [start, end) range in canonical text. */
export type AnchorResolution =
  | { status: "resolved"; start: number; end: number }
  | { status: "orphaned" };

/** diff-match-patch fuzzy threshold (SPECS §7.3). */
export const FUZZY_THRESHOLD = 0.3;
/**
 * diff-match-patch's BITAP pattern cap (its default `Match_MaxBits`):
 * `match_bitap_` THROWS for patterns longer than this. Longer anchors skip
 * the fuzzy step and degrade to steps 1–2 or orphaned instead of crashing.
 */
export const FUZZY_MAX_PATTERN = 32;
/** Fuzzy match_max: how much search text per step of target text. */
const FUZZY_MATCH_MAX = 500;
/** Progressive fuzzy windows around the hint (chars), final = whole text. */
const FUZZY_WINDOWS = [2048, 16384];

/**
 * Shared by steps 1–2: does `exact` sit at `pos` with the expected context?
 * The context match is required for step 1 and is part of the score for
 * step 2; it is only checked over the prefix/suffix we actually have.
 */
function contextMatches(text: string, pos: number, anchor: ResolvableAnchor): boolean {
  if (anchor.prefix !== "") {
    if (text.slice(Math.max(0, pos - anchor.prefix.length), pos) !== anchor.prefix) {
      return false;
    }
  }
  if (anchor.suffix !== "") {
    if (text.slice(pos + anchor.exact.length, pos + anchor.exact.length + anchor.suffix.length) !== anchor.suffix) {
      return false;
    }
  }
  return true;
}

/** How many leading chars of `ctx` equal the text right before `pos` (0..ctx.length). */
function prefixScore(text: string, pos: number, ctx: string): number {
  if (ctx === "") return 0;
  let s = 0;
  const from = Math.max(0, pos - ctx.length);
  const avail = pos - from;
  for (let i = 0; i < Math.min(avail, ctx.length); i++) {
    if (text[from + i] !== ctx[i]) break;
    s++;
  }
  return s;
}

/** How many leading chars of `ctx` equal the text right after `pos+exact.length` (0..ctx.length). */
function suffixScore(text: string, pos: number, exactLen: number, ctx: string): number {
  if (ctx === "") return 0;
  let s = 0;
  const from = pos + exactLen;
  for (let i = 0; i < ctx.length && from + i < text.length; i++) {
    if (text[from + i] !== ctx[i]) break;
    s++;
  }
  return s;
}

/** diff-match-patch instance, reused across calls (stateless here). */
let dmp: DiffMatchPatch | undefined;
function fuzzy(): DiffMatchPatch {
  if (!dmp) {
    dmp = new DiffMatchPatch();
    dmp.Match_Threshold = FUZZY_THRESHOLD;
    dmp.Match_Distance = 10_000;
  }
  return dmp;
}

/**
 * Fuzzy search for `anchor.exact` in `text`, biased toward `anchor.offsetHint`
 * (SPECS §7.3). Searches a growing window centered on the hint so the match
 * nearest the hint wins; falls back to the whole text. Returns the start
 * offset or -1.
 */
function fuzzyFind(text: string, anchor: ResolvableAnchor): number {
  // diff-match-patch's match_bitap_ throws 'Pattern too long for this
  // browser.' when the pattern exceeds its Match_MaxBits (32). Long highlights
  // therefore never reach the fuzzy step — they degrade to the literal
  // ladder (steps 1–2) or orphaned, which is the safe direction (SPECS §7.4).
  if (anchor.exact.length > FUZZY_MAX_PATTERN) return -1;
  if (anchor.exact.length > text.length) return -1;
  const d = fuzzy();
  const hint = Math.max(0, Math.min(anchor.offsetHint, text.length));
  const windows = FUZZY_WINDOWS.filter((w) => w < text.length);
  windows.push(text.length);
  for (const w of windows) {
    const from = Math.max(0, Math.min(hint - w / 2, text.length - w));
    const search = text.slice(from, from + w);
    const pos = d.match_main(search, anchor.exact, Math.min(Math.max(0, hint - from), search.length));
    if (pos >= 0) return from + pos;
  }
  return -1;
}

/**
 * The four-step resolution ladder (SPECS §7) over an arbitrary text string.
 * Shared by both anchor kinds: a ReflowAnchor resolves against a section's
 * canonical text, a PdfAnchor against that page's text-layer string.
 */
function resolveInText(anchor: ResolvableAnchor, text: string): AnchorResolution {
  const { exact, offsetHint } = anchor;
  if (exact === "") return { status: "orphaned" };

  // 1. Exact at the hint, with matching context.
  if (offsetHint >= 0 && offsetHint + exact.length <= text.length) {
    if (text.slice(offsetHint, offsetHint + exact.length) === exact) {
      if (contextMatches(text, offsetHint, anchor)) {
        return { status: "resolved", start: offsetHint, end: offsetHint + exact.length };
      }
    }
  }

  // 2. All occurrences, scored: prefix + suffix match − distance from hint.
  let best: { pos: number; score: number } | undefined;
  {
    const hint = Math.max(0, Math.min(offsetHint, text.length));
    let pos = text.indexOf(exact);
    while (pos !== -1) {
      const score =
        prefixScore(text, pos, anchor.prefix) +
        suffixScore(text, pos, exact.length, anchor.suffix) -
        Math.abs(pos - hint);
      if (!best || score > best.score) best = { pos, score };
      pos = text.indexOf(exact, pos + 1);
    }
  }
  if (best && best.score > 0) {
    return { status: "resolved", start: best.pos, end: best.pos + exact.length };
  }

  // 3. Fuzzy around the hint (content was edited after the highlight).
  const f = fuzzyFind(text, anchor);
  if (f >= 0) {
    return { status: "resolved", start: f, end: f + exact.length };
  }

  // 4. Orphaned — shown in the list, not in the text, never dropped.
  return { status: "orphaned" };
}

/**
 * Resolve a ReflowAnchor against a section's canonical text (SPECS §7, the
 * four-step ladder). `text` is `canonicalText(sectionHtml).text` — the same
 * string the client used when building the anchor, for an unmodified section.
 */
export function resolveAnchor(anchor: ReflowAnchor, text: string): AnchorResolution {
  return resolveInText(anchor, text);
}

/**
 * Resolve a PdfAnchor against its page's text-layer string (SPECS §7 — the
 * same ladder as reflow anchors, over the page text instead of canonical
 * section text). `text` is the concatenation of the page's text items in
 * reading order — the same string the client built the anchor from.
 */
export function resolvePdfAnchor(anchor: PdfAnchor, text: string): AnchorResolution {
  return resolveInText(anchor, text);
}

// ---------------------------------------------------------------------------
// Markdown export (GET /v1/export/highlights.md)
// ---------------------------------------------------------------------------

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const highlightColor = z.enum(HIGHLIGHT_COLORS);

export interface HighlightExportRow {
  /** The anchor's `exact` text (what was highlighted, canonical form). */
  exact: string;
  /** Display title of the containing section (e.g. "Chapter One"). */
  sectionTitle: string | null;
  /** Color, or null when never set. */
  color: HighlightColor | null;
  /** User note, or null. */
  note: string | null;
  /** True when the anchor no longer resolves in the current section text. */
  orphaned: boolean;
}

const COLOR_LABEL: Record<HighlightColor, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
};

/** Render one document's highlights as a Markdown block (or "" when none). */
export function formatHighlightMarkdown(
  title: string,
  rows: HighlightExportRow[],
): string {
  if (rows.length === 0) return "";
  const lines: string[] = [`# ${title}`, ""];
  for (const row of rows) {
    const tag = row.color ? `[${COLOR_LABEL[row.color]}] ` : "";
    lines.push(`> ${tag}${row.exact.replace(/\n/g, " ")}`);
    const where = row.sectionTitle ?? "unknown section";
    lines.push(`> — ${where}${row.orphaned ? " (orphaned)" : ""}`);
    if (row.note) lines.push(`> Note: ${row.note}`);
    lines.push("");
  }
  return lines.join("\n");
}
