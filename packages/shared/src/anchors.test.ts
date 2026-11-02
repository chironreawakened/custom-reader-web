import { describe, expect, it } from "vitest";
import {
  ANCHOR_CONTEXT_CHARS,
  FUZZY_THRESHOLD,
  buildReflowAnchor,
  formatHighlightMarkdown,
  highlightColor,
  reflowAnchor,
  resolveAnchor,
  type ReflowAnchor,
} from "./anchors.js";
import { canonicalText } from "./canonical-text.js";
import { el, txt, type CTElement } from "./canonical-text-testdom.js";

const p = (children: Parameters<typeof el>[1]) => el("p", children);
const h2 = (children: Parameters<typeof el>[1]) => el("h2", children);

const SID = "00000000-0000-7000-8000-000000000001";
const PAT = "keeper walked the spiral"; // 24 chars

/**
 * The fixture section: a heading + two paragraphs (mirrors the e2e fixture
 * EPUB's Chapter One, so a cross-paragraph highlight here is the same shape
 * the browser produces).
 */
function fixtureSection(): CTElement {
  return el("body", [
    h2([txt("Chapter One")]),
    p([txt("The lighthouse keeper walked the spiral stairs each dawn.")]),
    p([txt("The fog had not lifted in three days and the lamp was his only clock.")]),
  ]);
}

function fixtureCanonical(): string {
  return canonicalText(fixtureSection()).text;
}

// A section where one phrase occurs twice, for scoring-ladder tests.
const T2 = "Alpha beta gamma.\nDelta the river flows.\nEpsilon the river sings.\nZeta end.";
const RIVER_A = T2.indexOf("the river"); // 24, Delta line
const RIVER_B = T2.indexOf("the river", RIVER_A + 1); // 49, Epsilon line

describe("anchors (SPECS §7)", () => {
  it("golden: fixture HTML → canonical text", () => {
    expect(fixtureCanonical()).toBe(
      "Chapter One\n" +
        "The lighthouse keeper walked the spiral stairs each dawn.\n" +
        "The fog had not lifted in three days and the lamp was his only clock.",
    );
  });

  const FIX = fixtureCanonical();
  const SINGLE = FIX.indexOf(PAT); // 27
  // Cross-paragraph selection: tail of paragraph 2 + all of paragraph 3.
  const CROSS = FIX.indexOf("each dawn.\nThe fog");

  it("buildReflowAnchor: single paragraph, ≤32-char contexts", () => {
    const a = buildReflowAnchor(SID, { start: SINGLE, end: SINGLE + PAT.length }, FIX);
    expect(a).toMatchObject({
      kind: "reflow",
      v: 1,
      sectionId: SID,
      exact: PAT,
      offsetHint: SINGLE,
    });
    expect(a.prefix).toBe("Chapter One\nThe lighthouse "); // whole text before, 27 < 32
    expect(a.suffix).toBe(" stairs each dawn.\nThe fog had n"); // 32 chars
    expect(a.prefix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_CHARS);
    expect(a.suffix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_CHARS);
  });

  it("buildReflowAnchor: cross-paragraph selection keeps \\n in exact", () => {
    const a = buildReflowAnchor(SID, { start: CROSS, end: FIX.length }, FIX);
    expect(a.exact).toBe("each dawn.\nThe fog had not lifted in three days and the lamp was his only clock.");
    expect(a.exact).toContain("\n");
    expect(a.suffix).toBe("");
  });

  it("buildReflowAnchor: clamps contexts at the text edges", () => {
    const a = buildReflowAnchor(SID, { start: 0, end: 11 }, FIX);
    expect(a.prefix).toBe("");
    expect(a.exact).toBe("Chapter One");
    expect(a.suffix).toBe("\nThe lighthouse keeper walked th"); // 32 chars
  });

  it("buildReflowAnchor: rejects empty/out-of-range selections", () => {
    expect(() => buildReflowAnchor(SID, { start: 5, end: 5 }, FIX)).toThrow(/empty or out-of-range/);
    expect(() => buildReflowAnchor(SID, { start: 10, end: 4 }, FIX)).toThrow(/empty or out-of-range/);
    expect(() => buildReflowAnchor(SID, { start: 0, end: FIX.length + 1 }, FIX)).toThrow(/empty or out-of-range/);
  });

  it("resolves step 1: exact at the hint with matching context", () => {
    const a = buildReflowAnchor(SID, { start: SINGLE, end: SINGLE + PAT.length }, FIX);
    expect(resolveAnchor(a, FIX)).toEqual({ status: "resolved", start: SINGLE, end: SINGLE + PAT.length });
  });

  it("resolves step 2: hint a few chars off — context score wins over distance 0", () => {
    // Exact at 24, but the hint is 3 past it: step 1 misses, step 2 scores
    // 6 (prefix) + 7 (suffix) − 3 (distance) = 10 > 0 → the true occurrence.
    const a: ReflowAnchor = {
      kind: "reflow", v: 1, sectionId: SID,
      exact: "the river", prefix: "Delta ", suffix: " flows.",
      offsetHint: RIVER_A + 3, canonicalTextVersion: 1,
    };
    expect(resolveAnchor(a, T2)).toEqual({ status: "resolved", start: RIVER_A, end: RIVER_A + 9 });
  });

  it("resolves (step 1 → 3 fallback): context mismatch at hint, far occurrence, fuzzy recovers", () => {
    // Anchor context belongs to the Delta line, but the hint sits on the
    // Epsilon-line occurrence. Step 1: exact matches at the hint, context
    // does not → fail. Step 2: Delta occurrence scores 13 − 25 = −12, Epsilon
    // occurrence scores 0 → no positive score. Step 3: fuzzy finds the
    // literal exact at the hint → resolved there (never dropped, never wrong
    // paragraph for a literal match).
    const a: ReflowAnchor = {
      kind: "reflow", v: 1, sectionId: SID,
      exact: "the river", prefix: "Delta ", suffix: " flows.",
      offsetHint: RIVER_B, canonicalTextVersion: 1,
    };
    expect(resolveAnchor(a, T2)).toEqual({ status: "resolved", start: RIVER_B, end: RIVER_B + 9 });
  });

  it("resolves step 3: fuzzy after an insertion before the span", () => {
    const a = buildReflowAnchor(SID, { start: SINGLE, end: SINGLE + PAT.length }, FIX);
    // The section text gained an inserted clause before the highlight.
    const inserted = "quietly and without a word ";
    const edited = FIX.slice(0, SINGLE) + inserted + FIX.slice(SINGLE);
    const res = resolveAnchor(a, edited);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.start).toBe(SINGLE + inserted.length);
      expect(edited.slice(res.start, res.end)).toBe(PAT);
    }
  });

  it("resolves step 3: fuzzy after a 1-char edit inside the span", () => {
    const a = buildReflowAnchor(SID, { start: SINGLE, end: SINGLE + PAT.length }, FIX);
    // "spiral" → "spirey": same length, one differing char (score ≈ 0.96 ≥ 0.3).
    const edited = FIX.replace("spiral", "spirey");
    const res = resolveAnchor(a, edited);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.start).toBe(SINGLE);
      expect(edited.slice(res.start, res.end)).toBe("keeper walked the spirey");
    }
  });

  it("orphaned: the exact text no longer exists at all (SPECS §7.4)", () => {
    const a = buildReflowAnchor(SID, { start: SINGLE, end: SINGLE + PAT.length }, FIX);
    const res = resolveAnchor(a, "Completely different section text.");
    expect(res).toEqual({ status: "orphaned" });
  });

  it("orphaned: no literal match and nothing fuzzy either — never a false positive", () => {
    const a: ReflowAnchor = {
      kind: "reflow", v: 1, sectionId: SID,
      exact: "zzz qqq xxx yyy", prefix: "nope", suffix: "nope",
      offsetHint: 0, canonicalTextVersion: 1,
    };
    expect(resolveAnchor(a, FIX).status).toBe("orphaned");
  });

  it("zod: reflowAnchor validates and rejects unknown fields / wrong kind", () => {
    const ok = reflowAnchor.safeParse(buildReflowAnchor(SID, { start: 0, end: 5 }, FIX));
    expect(ok.success).toBe(true);
    const bad = reflowAnchor.safeParse({ ...buildReflowAnchor(SID, { start: 0, end: 5 }, FIX), extra: 1 });
    expect(bad.success).toBe(false);
    const pdfKind = reflowAnchor.safeParse({ kind: "pdf", v: 1, page: 1, exact: "x", offsetHint: 0 });
    expect(pdfKind.success).toBe(false);
  });

  it("markdown export: colour, section, note, orphaned, newlines flattened", () => {
    const md = formatHighlightMarkdown("The Lighthouse", [
      { exact: "each dawn.\nThe fog had not lifted", sectionTitle: "Chapter One", color: "yellow", note: "Nice line.", orphaned: false },
      { exact: "The lamp was his only clock.", sectionTitle: null, color: null, note: null, orphaned: true },
    ]);
    expect(md).toBe(
      "# The Lighthouse\n" +
        "\n" +
        "> [Yellow] each dawn. The fog had not lifted\n" +
        "> — Chapter One\n" +
        "> Note: Nice line.\n" +
        "\n" +
        "> The lamp was his only clock.\n" +
        "> — unknown section (orphaned)\n",
    );
    expect(formatHighlightMarkdown("Empty", [])).toBe("");
  });

  it("constants: contexts capped at 32, fuzzy threshold 0.3 (SPECS §7)", () => {
    expect(ANCHOR_CONTEXT_CHARS).toBe(32);
    expect(FUZZY_THRESHOLD).toBe(0.3);
    expect(highlightColor.options).toEqual(["yellow", "green", "blue", "pink"]);
  });
});
