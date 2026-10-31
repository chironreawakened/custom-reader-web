import { describe, expect, it } from "vitest";
import { imageSize, mimeByPath } from "./image-size.js";

// 1x1 red PNG (generated, valid).
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const PNG_1PX = b64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC");

// 3x2 green PNG (generated, valid).
const PNG_3x2 = b64("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAD0lEQVR4nGNg+M8ARXAWADvYBfuy4lFgAAAAAElFTkSuQmCC");

describe("imageSize", () => {
  it("reads PNG dimensions", () => {
    expect(imageSize(PNG_1PX)).toEqual({ width: 1, height: 1 });
    expect(imageSize(PNG_3x2)).toEqual({ width: 3, height: 2 });
  });

  it("returns null for non-image / truncated bytes", () => {
    expect(imageSize(new TextEncoder().encode("not an image at all"))).toBeNull();
    expect(imageSize(new Uint8Array([0, 1, 2]))).toBeNull();
  });
});

describe("mimeByPath", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(mimeByPath("a/b/c.png")).toBe("image/png");
    expect(mimeByPath("cover.jpg")).toBe("image/jpeg");
    expect(mimeByPath("x.JPEG")).toBe("image/jpeg");
    expect(mimeByPath("weird.thing")).toBe("application/octet-stream");
  });
});
