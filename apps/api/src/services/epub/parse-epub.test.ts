import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseEpub, EpubError } from "./parse-epub.js";
import { buildFixtureEpub, type FixtureSpec } from "./fixture-epub.js";

// 1x1 red PNG (generated, valid).
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const PNG_1PX = b64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC");

const MINIMAL: FixtureSpec = {
  title: "Test Book",
  author: "Author One",
  language: "en",
  spine: [
    { id: "s0", href: "s0.xhtml", html: "<h1>Test Book</h1><p>Hello world.</p>" },
    { id: "s1", href: "s1.xhtml", html: "<h2>Chapter One</h2><p>Second section text here.</p>" },
  ],
  toc: [
    { label: "Test Book", href: "s0.xhtml" },
    { label: "Chapter One", href: "s1.xhtml" },
  ],
};

describe("parseEpub — minimal fixture", () => {
  it("parses metadata, spine order, toc and word counts", async () => {
    const buf = await buildFixtureEpub(MINIMAL);
    const { epub, drm } = await parseEpub(buf);
    expect(drm).toBeNull();
    expect(epub.title).toBe("Test Book");
    expect(epub.author).toBe("Author One");
    expect(epub.dcLanguage).toBe("en");
    expect(epub.language).toBe("english");
    expect(epub.sections).toHaveLength(2);
    expect(epub.sections[0]!.title).toBe("Test Book");
    expect(epub.sections[1]!.title).toBe("Chapter One");
    expect(epub.toc).toHaveLength(2);
    expect(epub.toc[0]!.sectionIdx).toBe(0);
    expect(epub.toc[1]!.sectionIdx).toBe(1);
    expect(epub.wordCount).toBeGreaterThan(0);
    expect(epub.sections[1]!.html).toContain("Second section text here.");
  });

  it("maps fi-FI to finnish, unknown codes to simple, none to null", async () => {
    const fi = await buildFixtureEpub({ ...MINIMAL, language: "fi-FI" });
    expect((await parseEpub(fi)).epub.language).toBe("finnish");
    const de = await buildFixtureEpub({ ...MINIMAL, language: "de" });
    expect((await parseEpub(de)).epub.language).toBe("simple");
    const none = await buildFixtureEpub({ ...MINIMAL, language: null });
    expect((await parseEpub(none)).epub.language).toBeNull();
  });

  it("parses the legacy NCX toc", async () => {
    const buf = await buildFixtureEpub({ ...MINIMAL, toc: null, ncx: true });
    const { epub } = await parseEpub(buf);
    expect(epub.toc.map((t) => t.label)).toEqual(["Test Book", "Chapter One"]);
  });

  it("falls back to spine-derived TOC when no nav/NCX", async () => {
    const buf = await buildFixtureEpub({ ...MINIMAL, toc: null });
    const { epub } = await parseEpub(buf);
    expect(epub.toc).toHaveLength(2);
  });
});

describe("parseEpub — images and cover", () => {
  it("stores referenced images as assets and rewrites them to asset:<id>", async () => {
    const buf = await buildFixtureEpub({
      ...MINIMAL,
      images: { "pixel.png": PNG_1PX },
      spine: [
        {
          id: "s0",
          href: "s0.xhtml",
          html: '<h1>Book</h1><p>Text.</p><img src="pixel.png" alt="pic"/>',
        },
      ],
      toc: null,
    });
    const { epub } = await parseEpub(buf);
    expect(epub.assets).toHaveLength(1);
    const asset = epub.assets[0]!;
    expect(asset.mime).toBe("image/png");
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(asset.role).toBe("image");
    expect(epub.sections[0]!.html).toContain(`asset:${asset.id}`);
    expect(epub.sections[0]!.html).not.toContain('src="pixel.png"');
  });

  it("marks the cover item with role cover and sets coverAssetId", async () => {
    const buf = await buildFixtureEpub({
      ...MINIMAL,
      images: { "cover.png": PNG_1PX },
      cover: "cover",
      coverHref: "cover.png",
    });
    const { epub } = await parseEpub(buf);
    const cover = epub.assets.find((a) => a.role === "cover");
    expect(cover).toBeTruthy();
    expect(epub.coverAssetId).toBe(cover!.id);
  });
});

describe("parseEpub — sanitization", () => {
  it("strips script/style/event handlers from section HTML", async () => {
    const buf = await buildFixtureEpub({
      ...MINIMAL,
      spine: [
        {
          id: "s0",
          href: "s0.xhtml",
          html: "<h1>Book</h1><p onclick='alert(1)'>ok</p><script>alert(2)</script><style>.x{}</style>",
        },
      ],
      toc: null,
    });
    const { epub } = await parseEpub(buf);
    const html = epub.sections[0]!.html;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("onclick");
    expect(html).toContain("ok");
  });
});

describe("parseEpub — failures", () => {
  it("rejects non-zip bytes", async () => {
    await expect(parseEpub(new TextEncoder().encode("definitely not a zip"))).rejects.toThrow(EpubError);
  });

  it("rejects a zip whose OPF is missing", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file(
      "META-INF/container.xml",
      "<?xml version='1.0'?><container version='1.0' xmlns='urn:oasis:names:tc:opendocument:xmlns:container'><rootfiles><rootfile full-path='OEBPS/content.opf' media-type='application/oebps-package+xml'/></rootfiles></container>",
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(parseEpub(bytes)).rejects.toThrow(EpubError);
  });

  it("rejects an empty spine", async () => {
    const buf = await buildFixtureEpub({ ...MINIMAL, spine: [], toc: null });
    await expect(parseEpub(buf)).rejects.toThrow(EpubError);
  });
});
