/**
 * Slice 7 TTS contract (SPECS §10) — shared by the API and the web client.
 *
 * Web-safe: no node builtins (the barrel re-exports this; see the shared
 * package's node-crypto rule). The cache-key hash itself is computed
 * server-side (node:crypto) from these constants.
 */
import { z } from "zod";

/**
 * Bumped when anything that feeds the cache key changes: the chunking
 * algorithm, the model/voice set, or the text the chunks are cut from. A
 * bump makes every existing cache entry miss (new sha256 inputs).
 */
export const TTS_NORMALIZATION_VERSION = 1;

/**
 * Target max chunk length in canonical-text characters. Kept under OpenAI's
 * per-request input limit (2000 tokens for gpt-4o-mini-tts, ~8k chars) so a
 * chunk always fits one request; 1500 also keeps one chunk's audio short
 * enough for snappy playback and cheap caching.
 */
export const TTS_MAX_CHARS = 1500;

/** SPECS §10: the default model. Kept as an enum so an OpenAI rename is a
 *  shared-package change in one place; `z.enum` values must be static. */
export const ttsModel = z.enum(["gpt-4o-mini-tts"]);
export type TtsModel = z.infer<typeof ttsModel>;

/** Voices gpt-4o-mini-tts supports (per the OpenAI TTS docs, 2026-11).
 *  Exported as a plain const (not just the zod enum) so web code can list
 *  them in a <select> without reaching into zod internals. */
export const TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "marshall",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;
export const ttsVoice = z.enum(TTS_VOICES);
export type TtsVoice = (typeof TTS_VOICES)[number];

export const TTS_DEFAULT_MODEL: TtsModel = "gpt-4o-mini-tts";
export const TTS_DEFAULT_VOICE: TtsVoice = "alloy";

export interface TtsChunk {
  /** Zero-based, in reading order. */
  index: number;
  /** Inclusive start, exclusive end — canonical offsets into the section's
   *  canonical text (SPECS §6), so web/worker/client all agree byte-for-byte. */
  startOffset: number;
  endOffset: number;
  /** The chunk text itself (the API omits it in the listing response; the
   *  client only needs the offsets for highlighting). */
  text: string;
}

/** Sentence terminator: . ! ? …, optionally followed by a closing
 *  quote/bracket, then whitespace or the end of the paragraph. */
// NOTE: `g`, NOT `y` — a sticky regex only matches at exactly lastIndex and
// would never find a terminator a few chars ahead. The loop below positions
// lastIndex explicitly for each search.
const SENTENCE_END = /([.!?…][\s"'”’)»\]]*)/g;

/**
 * Split one paragraph into sentences at canonical offsets. A boundary falls
 * AFTER a terminator (`. ! ? …`) plus any closing quote/bracket and the
 * whitespace that follows it, so the next span starts at its first letter
 * (`push()` trims the rest). Chunks addressed by these spans are separate
 * synthesis calls, so a mid-abbreviation split ("e.g.") is harmless — it
 * just makes one chunk slightly shorter.
 *
 * Returns [start, end) spans covering the paragraph exactly (no gaps, no
 * overlap); an empty paragraph yields no spans.
 */
export function sentenceSpans(paragraph: string): Array<{ start: number; end: number }> {
  // The regex is module-level state: reset lastIndex before searching a
  // new paragraph (a leftover from a previous call would skip matches).
  SENTENCE_END.lastIndex = 0;
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  let i = 0;
  for (;;) {
    SENTENCE_END.lastIndex = i;
    const m = SENTENCE_END.exec(paragraph);
    if (!m) break;
    const end = m.index + m[0].length;
    spans.push({ start, end });
    start = end;
    i = end;
    if (i >= paragraph.length) break;
  }
  if (start < paragraph.length) spans.push({ start, end: paragraph.length });
  return spans;
}

/**
 * SPECS §10 chunking: split the section's canonical text on paragraphs
 * (`\n`); a paragraph longer than TTS_MAX_CHARS is split further on sentence
 * boundaries, and a single sentence longer than TTS_MAX_CHARS falls back to a
 * whitespace split (last resort — OpenAI's real limit is far higher, this
 * only guards against pathological input).
 *
 * Chunks cover the text's characters exactly, in order; offsets are into the
 * original string (so the web reader can map them onto the rendered section
 * with the same CanonicalMap it uses for highlights).
 */
export function chunkCanonicalText(text: string): TtsChunk[] {
  const chunks: TtsChunk[] = [];
  let index = 0;
  const push = (start: number, end: number) => {
    // Trim leading/trailing whitespace from the spoken text but keep the
    // canonical span tight to the spoken characters.
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s]!)) s += 1;
    while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
    if (s >= e) return;
    chunks.push({ index: index++, startOffset: s, endOffset: e, text: text.slice(s, e) });
  };

  // Offset-walk over paragraphs (split("\n") loses the \n offsets).
  let offset = 0;
  for (const para of text.split("\n")) {
    const paraStart = offset;
    const paraEnd = offset + para.length;
    offset = paraEnd + 1; // the \n itself
    if (para.length <= TTS_MAX_CHARS) {
      push(paraStart, paraEnd);
      continue;
    }
    for (const span of sentenceSpans(para)) {
      let s = paraStart + span.start;
      let e = paraStart + span.end;
      if (e - s > TTS_MAX_CHARS) {
        // Pathological single sentence: hard-split on whitespace.
        let cut = s;
        while (cut + TTS_MAX_CHARS < e) {
          let at = -1;
          for (let k = cut + TTS_MAX_CHARS; k > cut; k--) {
            if (/\s/.test(text[k]!)) { at = k; break; }
          }
          const next = at === -1 ? cut + TTS_MAX_CHARS : at;
          push(cut, next);
          cut = next;
        }
        push(cut, e);
      } else {
        push(s, e);
      }
    }
  }
  return chunks;
}

/** GET /v1/documents/:id/sections/:sid/tts-chunks — the client never sees
 *  chunk text, only offsets (SPECS §10). */
export const ttsChunkItem = z.object({
  index: z.number().int().min(0),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
});
export type TtsChunkItem = z.infer<typeof ttsChunkItem>;

export const ttsChunksResponse = z.object({
  chunks: z.array(ttsChunkItem),
  model: ttsModel,
  voice: ttsVoice,
});
export type TtsChunksResponse = z.infer<typeof ttsChunksResponse>;

/** POST /v1/tts — chunks are addressed, never free text (SPECS §10). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const postTtsBody = z
  .object({
    documentId: z.string().regex(UUID, "documentId is not a uuid"),
    sectionId: z.string().regex(UUID, "sectionId is not a uuid"),
    chunkIndex: z.number().int().min(0),
  })
  .strict();
export type PostTtsBody = z.infer<typeof postTtsBody>;

/** 200 = ready now (cache hit); 202 = queued, re-POST to poll. */
export const postTtsResponse = z.object({
  status: z.enum(["ready", "processing"]),
  url: z.string().optional(),
});
export type PostTtsResponse = z.infer<typeof postTtsResponse>;

/** PUT /v1/settings/openai-key */
export const putOpenAiKeyBody = z
  .object({
    key: z.string().min(11, "key looks too short").max(256, "key looks too long").trim(),
  })
  .strict();
export type PutOpenAiKeyBody = z.infer<typeof putOpenAiKeyBody>;
