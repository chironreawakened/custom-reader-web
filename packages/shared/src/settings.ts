/**
 * Slice 3 user-settings contract (SPECS §11, §12) — shared by the API and the
 * web client. Slice 3 stores `readerPrefs` (theme + font size); the TTS and
 * OpenAI-key fields on `app.user_settings` get their routes in later slices.
 */
import { z } from "zod";

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

/** GET /v1/settings */
export const getSettingsResponse = z.object({
  readerPrefs,
});
export type GetSettingsResponse = z.infer<typeof getSettingsResponse>;

/** PUT /v1/settings — partial: only readerPrefs is accepted in slice 3. */
export const putSettingsBody = z.object({ readerPrefs }).strict();
export type PutSettingsBody = z.infer<typeof putSettingsBody>;
