import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_PREFS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  putSettingsBody,
  readerPrefs,
} from "./settings.js";

describe("readerPrefs (slice 3)", () => {
  it("accepts the default prefs", () => {
    expect(readerPrefs.parse(DEFAULT_READER_PREFS)).toEqual(DEFAULT_READER_PREFS);
  });

  it("accepts every theme", () => {
    for (const theme of ["light", "sepia", "dark"] as const) {
      expect(readerPrefs.parse({ theme, fontSize: 16 }).theme).toBe(theme);
    }
  });

  it("rejects unknown themes", () => {
    expect(() => readerPrefs.parse({ theme: "black", fontSize: 16 })).toThrow();
  });

  it("bounds the font size to [12, 24] and requires an integer", () => {
    expect(readerPrefs.parse({ theme: "light", fontSize: MIN_FONT_SIZE }).fontSize).toBe(MIN_FONT_SIZE);
    expect(readerPrefs.parse({ theme: "light", fontSize: MAX_FONT_SIZE }).fontSize).toBe(MAX_FONT_SIZE);
    expect(() => readerPrefs.parse({ theme: "light", fontSize: MIN_FONT_SIZE - 1 })).toThrow();
    expect(() => readerPrefs.parse({ theme: "light", fontSize: MAX_FONT_SIZE + 1 })).toThrow();
    expect(() => readerPrefs.parse({ theme: "light", fontSize: 15.5 })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      putSettingsBody.parse({ readerPrefs: DEFAULT_READER_PREFS, extra: 1 }),
    ).toThrow();
  });
});
