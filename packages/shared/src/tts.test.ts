import { describe, expect, it } from "vitest";
import {
  TTS_MAX_CHARS,
  chunkCanonicalText,
  postTtsBody,
  putOpenAiKeyBody,
  sentenceSpans,
  ttsChunkItem,
  ttsChunksResponse,
} from "./tts.js";

const A = 200; // comfortable sub-limit sentence-ish run
const para = (n: number) => "word ".repeat(n).trim();

describe("sentenceSpans", () => {
  it("splits on . ! ? and end-of-paragraph", () => {
    const spans = sentenceSpans("One. Two! Three? Four.");
    // Trailing whitespace rides with the previous span (push() trims it).
    expect(spans).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
      { start: 10, end: 17 },
      { start: 17, end: 22 },
    ]);
    expect(spans.map((s) => "One. Two! Three? Four.".slice(s.start, s.end))).toEqual([
      "One. ",
      "Two! ",
      "Three? ",
      "Four.",
    ]);
  });

  it("keeps closing quotes with the sentence", () => {
    const spans = sentenceSpans(`Say "hi." Then go.`);
    expect(spans[0]!.end).toBe(10); // includes ."
    expect(spans[0]!.start).toBe(0);
    expect(spans[1]!.start).toBe(10);
  });

  it("covers the paragraph exactly (no gaps, no overlap)", () => {
    const p = "First, this. Then that — really. And: the rest.";
    const spans = sentenceSpans(p);
    expect(spans[0]!.start).toBe(0);
    expect(spans.at(-1)!.end).toBe(p.length);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBe(spans[i - 1]!.end);
      expect(spans[i]!.end).toBeGreaterThan(spans[i]!.start);
    }
  });

  it("handles no terminators and empty input", () => {
    expect(sentenceSpans("no end here")).toEqual([{ start: 0, end: 11 }]);
    expect(sentenceSpans("")).toEqual([]);
  });
});

describe("chunkCanonicalText", () => {
  it("one chunk per paragraph, offsets contiguous over the full text", () => {
    const text = "Para one.\n\nPara two here.";
    const chunks = chunkCanonicalText(text);
    expect(chunks.map((c) => c.text)).toEqual(["Para one.", "Para two here."]);
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks[0]!.endOffset).toBe(9);
    expect(chunks[1]!.startOffset).toBe(11); // after "Para one.\n\n"
    expect(chunks[1]!.endOffset).toBe(text.length);
    // The spoken chunks reassembled (whitespace-normalized) must equal the
    // original text normalized the same way.
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(chunks.map((c) => c.text).join(" ")).toBe(norm(text));
  });

  it("a short paragraph under the limit stays one chunk", () => {
    const p = para(20);
    const chunks = chunkCanonicalText(p);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(p);
  });

  it("splits an over-limit paragraph on sentence boundaries", () => {
    // Build a paragraph of "Sentence N." runs that exceeds TTS_MAX_CHARS.
    const sentences: string[] = [];
    let len = 0;
    let i = 0;
    while (len < TTS_MAX_CHARS + 10) {
      const s = `Sentence number ${i} says something short.`;
      sentences.push(s);
      len += s.length + 1;
      i++;
    }
    const p = sentences.join(" ");
    expect(p.length).toBeGreaterThan(TTS_MAX_CHARS);
    const chunks = chunkCanonicalText(p);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk respects the limit, and the concatenated text is the
    // original paragraph (whitespace normalized at boundaries).
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
      expect(p.slice(c.startOffset, c.endOffset)).toBe(c.text);
    }
    // Offsets strictly advance and cover the paragraph.
    let prevEnd = 0;
    for (const c of chunks) {
      expect(c.startOffset).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = c.endOffset;
    }
    expect(prevEnd).toBe(p.length);
  });

  it("handles an empty / whitespace-only text", () => {
    expect(chunkCanonicalText("")).toEqual([]);
    expect(chunkCanonicalText("   \n\n  \n")).toEqual([]);
  });
});

describe("tts zod schemas", () => {
  const DOC = "11111111-1111-1111-1111-111111111111";
  const SID = "22222222-2222-2222-2222-222222222222";

  it("postTtsBody validates the documented shape and rejects extras", () => {
    expect(postTtsBody.parse({ documentId: DOC, sectionId: SID, chunkIndex: 0 }).chunkIndex).toBe(0);
    expect(() => postTtsBody.parse({ documentId: DOC, sectionId: SID, chunkIndex: -1 })).toThrow();
    expect(() => postTtsBody.parse({ documentId: "nope", sectionId: SID, chunkIndex: 0 })).toThrow();
    expect(() =>
      postTtsBody.parse({ documentId: DOC, sectionId: SID, chunkIndex: 0, text: "free text" }),
    ).toThrow();
  });

  it("ttsChunkItem accepts integer offsets and rejects negatives", () => {
    expect(ttsChunkItem.parse({ index: 3, startOffset: 10, endOffset: 40 })).toBeTruthy();
    expect(() => ttsChunkItem.parse({ index: 0, startOffset: -1, endOffset: 4 })).toThrow();
  });

  it("ttsChunksResponse round-trips the spec shape", () => {
    const r = ttsChunksResponse.parse({
      chunks: [{ index: 0, startOffset: 0, endOffset: 5 }],
      model: "gpt-4o-mini-tts",
      voice: "nova",
    });
    expect(r.chunks).toHaveLength(1);
    expect(() => ttsChunksResponse.parse({ chunks: [], model: "tts-1", voice: "alloy" })).toThrow();
  });

  it("putOpenAiKeyBody bounds the key length", () => {
    expect(putOpenAiKeyBody.parse({ key: "sk-" + "a".repeat(48) }).key).toHaveLength(51);
    expect(() => putOpenAiKeyBody.parse({ key: "short" })).toThrow();
    expect(() => putOpenAiKeyBody.parse({ key: "a".repeat(300) })).toThrow();
  });
});
