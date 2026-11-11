/**
 * Slice 3 user-settings contract (SPECS §11, §12) — shared by the API and the
 * web client. Slice 3 stores `readerPrefs` (theme + font size); the TTS and
 * OpenAI-key fields on `app.user_settings` get their routes in later slices.
 */
import { z } from "zod";
import { ttsModel, ttsVoice } from "./tts.js";

export const readerTheme = z.enum(["light", "sepia", "dark"]);
export type ReaderTheme = z.infer<typeof readerTheme>;

export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 24;

/** Reader display preferences, stored as `user_settings.reader_prefs` (jsonb). */
export const readerPrefs = z
  .object({
    theme: readerTheme,
    /** Content font size in px. */
    fontSize: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE),
  })
  .strict();
export type ReaderPrefs = z.infer<typeof readerPrefs>;

/** Served when the user has no settings row yet. */
export const DEFAULT_READER_PREFS: ReaderPrefs = {
  theme: "light",
  fontSize: 16,
};

/** GET /v1/settings — TTS fields (slice 7): model/voice fall back to the
 *  SPECS §10 defaults when the user hasn't set them; `openaiKeyLast4` is
 *  non-null when a key is stored (the key itself is never returned). */
export const getSettingsResponse = z.object({
  readerPrefs,
  ttsModel: ttsModel,
  ttsVoice: ttsVoice,
  openaiKeyLast4: z.string().nullable(),
});
export type GetSettingsResponse = z.infer<typeof getSettingsResponse>;

/** PUT /v1/settings — partial: any of readerPrefs/ttsModel/ttsVoice; the
 *  route merges provided fields onto the stored row (slice 7). */
export const putSettingsBody = z
  .object({
    readerPrefs: readerPrefs.optional(),
    ttsModel: ttsModel.optional(),
    ttsVoice: ttsVoice.optional(),
  })
  .strict();
export type PutSettingsBody = z.infer<typeof putSettingsBody>;
