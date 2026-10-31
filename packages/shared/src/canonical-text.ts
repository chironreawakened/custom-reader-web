/**
 * Canonical text (SPECS §6) — implemented once, pure TS, runs on a minimal
 * DOM interface so the same code works in browsers, jsdom/linkedom (server)
 * and RN.
 *
 * `canonicalText(root) → { text, map }`
 *
 * Rules (SPECS §6, binding):
 *  1. Walk the DOM in document order.
 *  2. Ignore the contents of `script, style, rt, rp, template` and of
 *     elements marked `data-rdr-ignore`. Images contribute nothing.
 *  3. Block boundaries: the listed block elements start and end a block.
 *     Between blocks emit exactly one "\n"; never leading/trailing "\n";
 *     never two in a row.
 *  4. Inside `pre`: keep text as-is (convert \r\n to \n).
 *  5. Elsewhere: NBSP + all Unicode whitespace → space, collapse runs to one
 *     space, trim spaces adjacent to block boundaries.
 *  6. Unicode NFC applied text node by text node, before collapsing.
 *  7. Offsets are UTF-16 code units.
 *  8. `map` converts canonical offset ↔ (text node, offset in node) both ways.
 */

export const CANONICAL_TEXT_VERSION = 1;

// ---------------------------------------------------------------------------
// Minimal DOM interface
// ---------------------------------------------------------------------------

/** A text node: nodeType 3, carries its raw character data. */
export interface CTText {
  nodeType: 3;
  nodeName: string;
  data: string;
}

/** An element node: nodeType 1, children, attribute access. */
export interface CTElement {
  nodeType: 1;
  nodeName: string;
  childNodes: ArrayLike<CTNode>;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}

export type CTNode = CTText | CTElement;

/** Anything that looks like a DOM element (document.body, a jsdom element…). */
export type CTRoot = CTElement;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CanonicalMap {
  /**
   * Canonical text offset → the originating text node and the offset (UTF-16)
   * inside that node's original `data`. Offsets past the end clamp to the
   * last valid position.
   */
  toNode(canonicalOffset: number): { node: CTText; offset: number };
  /**
   * (Text node, offset in its original data) → canonical text offset.
   * Offsets past the node's text clamp to the node's end.
   */
  toCanonical(node: CTText, offsetInNode: number): number;
}

export interface CanonicalTextResult {
  text: string;
  map: CanonicalMap;
}

// ---------------------------------------------------------------------------
// The block / ignore sets (SPECS §6.2, §6.3)
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre",
  "div", "section", "article", "header", "footer", "aside", "figure",
  "figcaption", "table", "tr", "td", "th", "dt", "dd", "ul", "ol", "dl",
  "hr", "br",
]);

const IGNORE_TAGS = new Set(["script", "style", "rt", "rp", "template"]);

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

type Entry =
  | { kind: "text"; node: CTText; norm: NormRun }
  | { kind: "pre"; text: string }
  | { kind: "boundary" };

interface NormRun {
  /** Normalized (NFC, whitespace→space, collapsed) text of this node. */
  text: string;
  /** For each normalized char, the offset in the node's ORIGINAL data. */
  origOffset: number[];
}

/**
 * NFC-normalize a text node, then map each Unicode-whitespace run to a single
 * space. `origOffset[k]` is the offset (UTF-16) in the ORIGINAL data of the
 * first character of run/char k.
 */
function normalizeTextNode(data: string): NormRun {
  return rebuildNormRun(data.normalize("NFC"));
}

/**
 * Rebuild the normalized text with a correct per-character source offset map:
 * walk the NFC string char by char; emit a single space for each run of
 * whitespace (the space maps to the FIRST char of the run); pass other chars
 * through.
 */
function rebuildNormRun(nfc: string): NormRun {
  const out: string[] = [];
  const orig: number[] = [];
  let i = 0;
  while (i < nfc.length) {
    const ch = nfc[i]!;
    if (isWs(ch)) {
      const runStart = i;
      while (i < nfc.length && isWs(nfc[i]!)) i++;
      // Collapse: one space per run (or none if we'd double up at a boundary
      // of the emitted text — handled at block assembly by trimming).
      out.push(" ");
      orig.push(runStart);
    } else {
      out.push(ch);
      orig.push(i);
      i++;
    }
  }
  return { text: out.join(""), origOffset: orig };
}

function isWs(ch: string): boolean {
  return (
    ch === "\u0020" || ch === "\u0009" || ch === "\u000B" || ch === "\u000C" ||
    ch === "\u00A0" || ch === "\u1680" || (ch >= "\u2000" && ch <= "\u200A") ||
    ch === "\u2028" || ch === "\u2029" || ch === "\u202F" || ch === "\u205F" ||
    ch === "\u3000" || ch === "\n" || ch === "\r"
  );
}

/** Pre block content: as-is except \r\n → \n. */
function collectPreText(node: CTNode, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(node.data.replace(/\r\n/g, "\n"));
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = tagOf(node);
  if (IGNORE_TAGS.has(tag)) return;
  for (let i = 0; i < node.childNodes.length; i++) collectPreText(node.childNodes[i]!, out);
}

function tagOf(el: CTElement): string {
  return el.nodeName.toLowerCase();
}

function isIgnored(el: CTElement): boolean {
  if (IGNORE_TAGS.has(tagOf(el))) return true;
  try {
    return el.hasAttribute("data-rdr-ignore");
  } catch {
    // Custom DOMs without hasAttribute: treat as not ignored.
    return false;
  }
}

function walk(node: CTNode, inPre: boolean, out: Entry[]): void {
  if (node.nodeType === 3) {
    if (inPre) return; // pre content collected separately
    const run = normalizeTextNode(node.data);
    if (run.text !== "") out.push({ kind: "text", node, norm: run });
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node;
  if (isIgnored(el)) return;
  const tag = tagOf(el);
  if (tag === "pre") {
    const parts: string[] = [];
    collectPreText(el, parts);
    const text = parts.join("");
    if (text !== "") out.push({ kind: "pre", text });
    return;
  }
  if (BLOCK_TAGS.has(tag)) {
    out.push({ kind: "boundary" });
  }
  for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]!, inPre, out);
  if (BLOCK_TAGS.has(tag)) {
    out.push({ kind: "boundary" });
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** One output char's provenance; null = not mapped (pre content). */
interface CharMap {
  node: CTText;
  offset: number;
}

interface Group {
  /** Final group text (collapsed + trimmed; pre groups kept as-is). */
  text: string;
  /** Provenance for each char of `text` (same length). */
  chars: Array<CharMap | null>;
}

function assembleGroup(entries: Entry[]): Group {
  const outChars: string[] = [];
  const outMap: Array<CharMap | null> = [];
  let prevSpace = false;

  const pushChar = (ch: string, mapped: CharMap | null, inPre: boolean) => {
    if (!inPre && ch === " ") {
      if (prevSpace) return; // collapse runs to one space (§6.5)
      prevSpace = true;
    } else {
      prevSpace = ch === " " && !inPre;
    }
    outChars.push(ch);
    outMap.push(mapped);
  };

  for (const e of entries) {
    if (e.kind === "pre") {
      // Inside pre: keep text as-is, no collapsing, no edge trimming (§6.4).
      for (const ch of e.text) pushChar(ch, null, true);
      continue;
    }
    if (e.kind === "boundary") continue;
    const norm = e.norm;
    for (let k = 0; k < norm.text.length; k++) {
      pushChar(norm.text[k]!, { node: e.node, offset: norm.origOffset[k]! }, false);
    }
  }

  // Trim spaces adjacent to block boundaries (§6.5).
  {
    let l = 0;
    while (l < outChars.length && outChars[l] === " ") l++;
    let r = outChars.length;
    while (r > l && outChars[r - 1] === " ") r--;
    if (l > 0 || r < outChars.length) {
      outChars.splice(0, outChars.length, ...outChars.slice(l, r));
      outMap.splice(0, outMap.length, ...outMap.slice(l, r));
    }
  }
  return {
    text: outChars.join(""),
    chars: outMap,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function canonicalText(root: CTRoot): CanonicalTextResult {
  const entries: Entry[] = [];
  walk(root, false, entries);

  // Group entries between boundaries.
  const groups: Entry[][] = [];
  let cur: Entry[] = [];
  for (const e of entries) {
    if (e.kind === "boundary") {
      if (cur.length) groups.push(cur);
      cur = [];
    } else {
      cur.push(e);
    }
  }
  if (cur.length) groups.push(cur);

  const assembled: Group[] = groups.map(assembleGroup).filter((g) => g.text !== "");
  const text = assembled.map((g) => g.text).join("\n");

  // Group starts in the final text.
  const groupStarts: number[] = [];
  {
    let off = 0;
    for (const g of assembled) {
      groupStarts.push(off);
      off += g.text.length + 1; // +1 for the joining "\n"
    }
  }

  // (node, original offset) → canonical offset, for toCanonical. The mapping
  // is injective (one output char per source char/whitespace-run-head), so
  // first-wins is well defined.
  const nodeMap = new Map<CTText, Map<number, number>>();
  for (let gi = 0; gi < assembled.length; gi++) {
    const g = assembled[gi]!;
    for (let f = 0; f < g.chars.length; f++) {
      const c = g.chars[f]!;
      if (!c) continue;
      let byOffset = nodeMap.get(c.node);
      if (!byOffset) {
        byOffset = new Map();
        nodeMap.set(c.node, byOffset);
      }
      byOffset.set(c.offset, groupStarts[gi]! + f);
    }
  }

  const groupOf = (off: number): { gi: number; local: number } => {
    const o = Math.max(0, Math.min(off, text.length));
    let gi = 0;
    while (gi < assembled.length - 1 && o >= groupStarts[gi]! + assembled[gi]!.text.length) {
      gi++;
    }
    const local = Math.min(o - groupStarts[gi]!, assembled[gi]!.text.length - 1);
    return { gi, local };
  };

  const map: CanonicalMap = {
    toNode(canonicalOffset: number): { node: CTText; offset: number } {
      const { gi, local } = groupOf(canonicalOffset);
      const g = assembled[gi]!;
      // Walk outwards to the nearest mapped char (newlines and pre content
      // are unmapped by design).
      for (let d = 0; d <= local; d++) {
        const c = g.chars[local - d];
        if (c) return c;
      }
      for (let d = 1; local + d < g.chars.length; d++) {
        const c = g.chars[local + d];
        if (c) return c;
      }
      for (let other = gi - 1; other >= 0; other--) {
        const og = assembled[other]!;
        for (let d = og.chars.length - 1; d >= 0; d--) {
          const c = og.chars[d]!;
          if (c) return c;
        }
      }
      for (let other = gi + 1; other < assembled.length; other++) {
        const og = assembled[other]!;
        for (let d = 0; d < og.chars.length; d++) {
          const c = og.chars[d]!;
          if (c) return c;
        }
      }
      throw new Error("no mapped text in document");
    },
    toCanonical(node: CTText, offsetInNode: number): number {
      const byOffset = nodeMap.get(node);
      if (!byOffset || byOffset.size === 0) return 0; // node not in canonical text
      const off = Math.max(0, offsetInNode);
      const exact = byOffset.get(off);
      if (exact !== undefined) return exact;
      let bestKey = -1;
      let nextKey = -1;
      for (const k of byOffset.keys()) {
        if (k <= off && k > bestKey) bestKey = k;
        if (k > off && (nextKey < 0 || k < nextKey)) nextKey = k;
      }
      if (bestKey >= 0) return byOffset.get(bestKey)!;
      if (nextKey >= 0) return byOffset.get(nextKey)!;
      return 0;
    },
  };

  return { text, map };
}
