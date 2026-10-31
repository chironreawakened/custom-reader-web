export type DocLanguage = "english" | "finnish" | "simple";

/**
 * Map the EPUB's `dc:language` (BCP-47) onto the reader's three canonical
 * languages (SPECS §11 / PLAN slice 2): `english | finnish | simple`.
 *
 * - en*             → english
 * - fi* (fi-FI etc) → finnish
 * - everything else → simple (readers render the same markup either way)
 *
 * Missing/undetectable → null (documents.dc_language is nullable).
 */
export function mapDcLanguage(raw: string | null | undefined): DocLanguage | null {
  if (!raw) return null;
  const lang = raw.trim().toLowerCase();
  if (!lang || lang === "und" || lang === "mul") return null;
  const primary = lang.split(/[-_]/)[0]!;
  if (primary === "en") return "english";
  if (primary === "fi") return "finnish";
  return "simple";
}
