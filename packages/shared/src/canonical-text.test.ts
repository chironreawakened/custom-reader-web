import { describe, expect, it } from "vitest";
import { CANONICAL_TEXT_VERSION, canonicalText } from "./index.js";
import { el, txt, type CTElement, type CTText } from "./canonical-text-testdom.js";

/** Convenience builders that match the testdom helpers' element casing. */
const div = (children: Parameters<typeof el>[1]) => el("div", children);
const p = (children: Parameters<typeof el>[1]) => el("p", children);
const h2 = (children: Parameters<typeof el>[1]) => el("h2", children);
const br = () => el("br", []);
const strong = (children: Parameters<typeof el>[1]) => el("strong", children);
const pre = (children: Parameters<typeof el>[1]) => el("pre", children);
const script = (children: Parameters<typeof el>[1]) => el("script", children);
const img = () => el("img", []);

describe("canonicalText (SPECS §6)", () => {
  it("version is pinned", () => {
    expect(CANONICAL_TEXT_VERSION).toBe(1);
  });

  it("golden: basic paragraphs, inline, block boundaries", () => {
    const root: CTElement = el(
      "body",
      [
        h2([txt("Chapter One")]),
        p([txt("Hello   world"), strong([txt("!")]), txt(" Second\u00A0para")]),
        p([txt("Third para with an <img>")]),
        p([img(), txt(" and text after image")]),
      ],
    );
    const { text, map } = canonicalText(root);
    expect(text).toBe("Chapter One\nHello world! Second para\nThird para with an <img>\nand text after image");
    void map;
  });

  it("emits exactly one newline between blocks, none at the edges", () => {
    const root: CTElement = el("body", [
      p([txt("a")]),
      div([p([txt("b")])]),
      el("ul", [el("li", [txt("c")]), el("li", [txt("d")])]),
    ]);
    expect(canonicalText(root).text).toBe("a\nb\nc\nd");
  });

  it("never emits two newlines in a row (nested blocks collapse)", () => {
    const root: CTElement = el("body", [
      div([div([p([txt("x")])])]),
      div([p([txt("y")])]),
    ]);
    expect(canonicalText(root).text).toBe("x\ny");
  });

  it("ignores script/style/rt/rp/template and data-rdr-ignore content", () => {
    const root: CTElement = el("body", [
      script([txt("alert(1)")]),
      p([txt("A "), el("style", [txt("x{}")]), txt("B")]),
      p([el("span", [txt("hidden")], { "data-rdr-ignore": "1" }), txt("C")]),
      p([el("ruby", [txt("字"), el("rt", [txt("し")])]), txt("D")]),
    ]);
    // ruby base text is kept; only rt/rp content is dropped (§6.2).
    expect(canonicalText(root).text).toBe("A B\nC\n字D");
  });

  it("images contribute nothing (no alt text)", () => {
    const root: CTElement = el("body", [
      p([img(), txt("only text")]),
      p([img()]),
    ]);
    expect(canonicalText(root).text).toBe("only text");
  });

  it("pre keeps text as-is (\\r\\n → \\n), no collapsing", () => {
    const root: CTElement = el("body", [
      p([txt("before")]),
      pre([txt("a  b\tc\r\nd e")]),
      p([txt("after")]),
    ]);
    expect(canonicalText(root).text).toBe("before\na  b\tc\nd e\nafter");
  });

  it("collapses unicode whitespace runs to one space, NFC output", () => {
    // "café" composed vs decomposed: use the decomposed form on input.
    const decomp = "cafe\u0301";
    const root: CTElement = el("body", [
      p([txt(`A\u00A0B\u2003\u2003C  D\tE`)]),
      p([txt(decomp)]),
    ]);
    const { text } = canonicalText(root);
    expect(text).toBe("A B C D E\ncafé");
  });

  it("map.toNode maps canonical offsets to original nodes/offsets", () => {
    const t1: CTText = txt("Hello world");
    const t2: CTText = txt("Second para");
    const root: CTElement = el("body", [p([t1]), p([t2])]);
    const { text, map } = canonicalText(root);
    expect(text).toBe("Hello world\nSecond para");
    expect(map.toNode(0)).toEqual({ node: t1, offset: 0 });
    expect(map.toNode(5)).toEqual({ node: t1, offset: 5 }); // 'o' in world
    expect(map.toNode(12)).toEqual({ node: t2, offset: 0 }); // "S"
    expect(map.toNode(999)).toEqual({ node: t2, offset: t2.data.length - 1 });
  });

  it("map.toCanonical is the inverse of map.toNode on mapped text", () => {
    const t1: CTText = txt("  Alpha   beta  ");
    const t2: CTText = txt("Gamma");
    const root: CTElement = el("body", [p([t1]), p([t2])]);
    const { text, map } = canonicalText(root);
    expect(text).toBe("Alpha beta\nGamma");
    // "Alpha beta": canonical 0..9
    expect(map.toCanonical(t1, 2)).toBe(0); // first non-ws char
    expect(map.toCanonical(t1, 7)).toBe(5); // ws run → first-wins → the space
    expect(map.toCanonical(t1, 8)).toBe(5); // inside the same ws run (7-9)
    expect(map.toCanonical(t1, 10)).toBe(6); // 'b' of "beta"
    expect(map.toCanonical(t2, 0)).toBe(11); // "G"
    // Round trip for every mapped offset (newlines are unmapped by design).
    for (let off = 0; off < text.length; off++) {
      if (text[off] === "\n") continue;
      const { node, offset } = map.toNode(off);
      const back = map.toCanonical(node, offset);
      expect(back).toBe(off);
    }
  });

  it("whitespace-only text nodes produce no spurious output", () => {
    const root: CTElement = el("body", [
      p([txt("a"), txt("   "), txt("b")]),
      txt("   "),
      p([txt("   ")]),
      p([txt("c")]),
    ]);
    expect(canonicalText(root).text).toBe("a b\nc");
  });

  it("br is a block boundary", () => {
    const root: CTElement = el("body", [p([txt("line1"), br(), txt("line2")])]);
    expect(canonicalText(root).text).toBe("line1\nline2");
  });
});
