/**
 * Slice 7 TTS service (SPECS §10): cache keys, the OpenAI speech call, and
 * error mapping.
 *
 * The OpenAI base URL is configurable so CI/e2e can point the worker at a
 * local mock (the same pattern as HIPPUS_ENDPOINT → s3mock).
 */
import { createHash } from "node:crypto";
import {
  TTS_NORMALIZATION_VERSION,
  type TtsModel,
  type TtsVoice,
} from "@reader/shared";

/** OpenAI's per-request input limit (checked against the current docs,
 *  2026-11: gpt-4o-mini-tts — 2000 input tokens, speech API input max
 *  4096 chars). Chunks stay far under this (TTS_MAX_CHARS = 1500). */
export const OPENAI_MAX_INPUT_CHARS = 4096;

export type OpenAiTtsErrorCode =
  | "bad_openai_key" // 401/403 — the stored key is wrong or revoked
  | "tts_rate_limited" // 429 — back off, the client retries
  | "tts_unavailable"; // anything else (network, 5xx, bad response)

export class OpenAiTtsError extends Error {
  constructor(
    public readonly code: OpenAiTtsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** SPECS §10: sha256(version | model | voice | chunkText), hex. */
export function ttsCacheKey(model: TtsModel, voice: TtsVoice, chunkText: string): string {
  const input = `${TTS_NORMALIZATION_VERSION}|${model}|${voice}|${chunkText}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface SynthesizeArgs {
  apiKey: string;
  model: TtsModel;
  voice: TtsVoice;
  text: string;
  /** Override for CI (mock OpenAI). Default: the real API. */
  baseUrl?: string;
  signal?: AbortSignal;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

/** Call OpenAI's speech endpoint and return the MP3 bytes.
 *  Throws OpenAiTtsError with a stable `code` the routes/worker map to
 *  client- or job-visible failures. */
export async function synthesizeChunk(args: SynthesizeArgs): Promise<Uint8Array> {
  const url = `${(args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/audio/speech`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        voice: args.voice,
        input: args.text,
        response_format: "mp3",
      }),
      ...(args.signal && { signal: args.signal }),
    });
  } catch (e) {
    throw new OpenAiTtsError("tts_unavailable", `openai request failed: ${String(e)}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new OpenAiTtsError("bad_openai_key", "the stored OpenAI key was rejected");
  }
  if (res.status === 429) {
    throw new OpenAiTtsError("tts_rate_limited", "openai rate limit hit; retry shortly");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OpenAiTtsError("tts_unavailable", `openai returned ${res.status} ${body.slice(0, 200)}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new OpenAiTtsError("tts_unavailable", "openai returned an empty audio body");
  }
  return buf;
}
