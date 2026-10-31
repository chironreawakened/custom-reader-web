import { describe, expect, it } from "vitest";
import { lastWriteWins, locator, putProgressBody, progressResponse } from "./progress.js";

describe("locator schema (SPECS §8)", () => {
  it("accepts a reflow locator", () => {
    const v = locator.parse({
      kind: "reflow",
      sectionId: "12345678-1234-4abc-8def-123456789abc",
      offset: 250,
      percent: 0.42,
    });
    expect(v).toEqual({
      kind: "reflow",
      sectionId: "12345678-1234-4abc-8def-123456789abc",
      offset: 250,
      percent: 0.42,
    });
  });

  it("accepts a pdf locator", () => {
    const v = locator.parse({ kind: "pdf", page: 7, percent: 1 });
    expect(v).toEqual({ kind: "pdf", page: 7, percent: 1 });
  });

  it("rejects a bad kind, a non-uuid sectionId, out-of-range percent, negative offset", () => {
    const uuid = "12345678-1234-4abc-8def-123456789abc";
    expect(() => locator.parse({ kind: "audiobook", sectionId: uuid, offset: 0, percent: 0 })).toThrow();
    expect(() => locator.parse({ kind: "reflow", sectionId: "nope", offset: 0, percent: 0 })).toThrow();
    expect(() => locator.parse({ kind: "reflow", sectionId: uuid, offset: 0, percent: 1.5 })).toThrow();
    expect(() => locator.parse({ kind: "reflow", sectionId: uuid, offset: 0, percent: -0.1 })).toThrow();
    expect(() => locator.parse({ kind: "reflow", sectionId: uuid, offset: -1, percent: 0 })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    const uuid = "12345678-1234-4abc-8def-123456789abc";
    expect(() =>
      locator.parse({ kind: "reflow", sectionId: uuid, offset: 0, percent: 0, extra: true }),
    ).toThrow();
  });
});

describe("putProgressBody / progressResponse (SPECS §12)", () => {
  it("requires a locator and an ISO datetime", () => {
    const body = putProgressBody.parse({
      locator: { kind: "pdf", page: 0, percent: 0 },
      updatedAt: "2026-10-31T09:00:00.000Z",
    });
    expect(body.updatedAt).toBe("2026-10-31T09:00:00.000Z");
    expect(() => putProgressBody.parse({ locator: { kind: "pdf", page: 0, percent: 0 } })).toThrow();
    expect(() =>
      putProgressBody.parse({
        locator: { kind: "pdf", page: 0, percent: 0 },
        updatedAt: "not-a-date",
      }),
    ).toThrow();
  });

  it("progressResponse accepts the empty (never-opened) shape", () => {
    const v = progressResponse.parse({ locator: null, updatedAt: null });
    expect(v.locator).toBeNull();
  });
});

describe("lastWriteWins (SPECS §8 — server keeps the newer value)", () => {
  it("first write always lands (no existing row)", () => {
    expect(lastWriteWins(null, "2026-10-31T09:00:00.000Z")).toBe("write");
  });

  it("a newer incoming write wins", () => {
    expect(lastWriteWins("2026-10-31T09:00:00.000Z", "2026-10-31T09:00:01.000Z")).toBe("write");
  });

  it("a stale incoming write is a conflict", () => {
    expect(lastWriteWins("2026-10-31T09:00:05.000Z", "2026-10-31T09:00:00.000Z")).toBe("conflict");
  });

  it("an equal timestamp wins (same client, retried request)", () => {
    expect(lastWriteWins("2026-10-31T09:00:00.000Z", "2026-10-31T09:00:00.000Z")).toBe("write");
  });

  it("garbage timestamps are conflicts, never writes", () => {
    expect(lastWriteWins("2026-10-31T09:00:00.000Z", "garbage")).toBe("conflict");
    expect(lastWriteWins("garbage", "2026-10-31T09:00:00.000Z")).toBe("conflict");
  });
});
