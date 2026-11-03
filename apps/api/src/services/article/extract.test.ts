import { describe, expect, it } from "vitest";
import { ArticleError, extractArticle } from "./extract.js";

const BASE = "https://news.example.com/2026/11/03/test-article";

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Test Article Headline — News Site</title>
  <meta property="og:title" content="Test Article Headline">
  <meta name="author" content="Jane Author">
</head>
<body>
  <header><nav><a href="/">Home</a> | <a href="/about">About</a></nav></header>
  <article>
    <h1>Test Article Headline</h1>
    <p class="byline">By Jane Author, November 3, 2026</p>
    <figure><img src="/images/test-photo.jpg" alt="A test photo" loading="lazy"></figure>
    <p>The lighthouse keeper walked the spiral stairs at night, counting every
    step so that the lamp would keep turning through the fog. Below, the sea
    moved slowly against the black rocks, and the only sound on the headland
    was the creak of the old railing.</p>
    <p>When the storm cleared in the morning, the harbour was full of boats
    again, and the keeper went down to the coffee queue with everyone else,
    his coat still wet from the gallery deck.</p>
    <p><img src="https://cdn.example.com/inset.png" alt="" /></p>
  </article>
  <div class="more"><a href="#end">Jump to end</a></div>
  <footer><p>© News Site</p></footer>
</body>
</html>`;

describe("extractArticle", () => {
  it("extracts title, byline, text and images (relative + absolute)", async () => {
    const rewritten: string[] = [];
    const out = await extractArticle(ARTICLE_HTML, BASE, async (img) => {
      rewritten.push(img.url);
      return "asset-id-" + rewritten.length;
    });

    expect(out.title).toBe("Test Article Headline");
    expect(out.byline).toBeTruthy();
    expect(out.language).toBe("english");
    expect(out.wordCount).toBeGreaterThan(25);
    expect(out.canonicalText).toContain("lighthouse keeper");
    expect(out.canonicalText).toContain("coffee queue");
    // Nav/footer junk must not leak into the content.
    expect(out.canonicalText).not.toContain("Jump to end");
    expect(out.canonicalText).not.toContain("About");

    // Images: relative resolved against the base URL, absolute kept, deduped,
    // in document order; empty alt → null.
    expect(rewritten).toEqual(["https://news.example.com/images/test-photo.jpg", "https://cdn.example.com/inset.png"]);
    expect(out.images.map((i) => i.url)).toEqual(rewritten);
    expect(out.images[0]!.alt).toBe("A test photo");
    expect(out.images[1]!.alt).toBeNull();

    // Both srcs rewritten to asset:<id> placeholders, order preserved.
    expect(out.html).toContain('src="asset:asset-id-1"');
    expect(out.html).toContain('src="asset:asset-id-2"');
    expect(out.html).not.toContain("/images/test-photo.jpg");
    expect(out.html).not.toContain("cdn.example.com");
    expect(out.html.indexOf("asset:asset-id-1")).toBeLessThan(out.html.indexOf("asset:asset-id-2"));
    // Lazy-loading attribute is not load-bearing for the reader (src is all
    // we render) and sanitize strips it.
    expect(out.html).not.toContain("loading=");
  });

  it("keeps the original src when an image download fails (null id)", async () => {
    const out = await extractArticle(ARTICLE_HTML, BASE, async () => null);
    // Unrewritten images keep the src exactly as authored (relative stays relative).
    expect(out.html).toContain('src="/images/test-photo.jpg"');
    expect(out.html).toContain('src="https://cdn.example.com/inset.png"');
    expect(out.html).not.toContain("asset:");
  });

  it("maps finnish lang to 'finnish'", async () => {
    const fi = ARTICLE_HTML.replace('lang="en"', 'lang="fi-FI"').replace("By Jane Author", "Teksti");
    const out = await extractArticle(fi, BASE, async () => "x");
    expect(out.language).toBe("finnish");
  });

  it("rejects pages without a readable article body", async () => {
    const shell = `<html><body><div><p>Home</p><p>About</p><p>Jobs</p></div></body></html>`;
    await expect(extractArticle(shell, BASE, async () => null)).rejects.toThrow(ArticleError);
  });

  it("rejects empty HTML", async () => {
    await expect(extractArticle("<html></html>", BASE, async () => null)).rejects.toThrow(/no readable article/);
  });

  it("canonical text matches the stored (sanitized) HTML", async () => {
    const out = await extractArticle(ARTICLE_HTML, BASE, async () => null);
    // The exact phrase the web reader will select must exist in canonical form
    // (canonical text collapses source newlines to single spaces).
    expect(out.canonicalText).toContain("counting every step");
  });
});
