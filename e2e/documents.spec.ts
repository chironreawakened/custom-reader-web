import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { login } from "./mailbox.js";
import { ensureArticleServer, ARTICLE_URL } from "./article-server.js";

// Slice 2 e2e: upload an EPUB through the real UI and read it back.
//   login (console mailbox) -> library -> upload fixture.epub via the file
//   input -> wait for the "ready" badge (the CI worker parses the book) ->
//   open the book -> assert TOC, cover image (signed asset URL), section
//   text and prev/next navigation.
//
// Slice 5 (same logged-in session — the e2e rate-limit budget is 4
// request-code calls per CI run, so no extra login here): add a URL article
// through the real UI. The worker (RDR_ENV=ci) fetches the loopback article
// fixture, extracts it, flips the doc to "ready" -> open the article ->
// assert the extracted headline/body render -> add a tag -> assert the tag
// chip appears AND the tag filter narrows the list to the tagged article.
//
// The fixture book is generated with apps/api/tools/make-fixture-epub.mjs so
// CI doesn't ship a binary in the repo. REPO_ROOT must point at the repo.

const FIXTURE = "/tmp/e2e-fixture.epub";
const FIXTURE_PDF = "/tmp/e2e-fixture-pdf.pdf";
const FIXTURE_PDF_SCANNED = "/tmp/e2e-fixture-pdf-scanned.pdf";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const root = process.env.REPO_ROOT;
  if (!root) throw new Error("REPO_ROOT not set");
  execFileSync("node", ["apps/api/tools/make-fixture-epub.mjs", FIXTURE], { cwd: root });
  // Slice 6 fixtures: the outline PDF (2 text pages + 2-entry TOC) and the
  // scanned PDF (image-only page, no text layer). Same reason as the epub —
  // generate in CI, never ship a binary.
  execFileSync("node", ["apps/api/tools/make-fixture-pdf.mjs", FIXTURE_PDF, "outline"], { cwd: root });
  execFileSync("node", ["apps/api/tools/make-fixture-pdf.mjs", FIXTURE_PDF_SCANNED, "scanned"], { cwd: root });
  // The article fixture is a loopback HTTP server; started here so the CI
  // worker (RDR_ENV=ci, loopback allowed) can fetch it. Idempotent.
  await ensureArticleServer();
});

// One serial test covering book + article + PDF, because each Playwright test
// gets a fresh context (no shared cookies) and the suite's request-code budget
// is 4 per run — a second login in a separate PDF test would be the forbidden
// 5th call. So the PDF flow piggybacks this single login.
test("documents: upload + read book, article, and PDF (faithful)", async ({ page }) => {
  await login(page);

  // Upload the fixture book through the hidden file input.
  await page.getByTestId("upload-input").setInputFiles(FIXTURE);

  // The library row appears (pending) and the worker flips it to "ready".
  const docRow = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await expect(docRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 90_000 });

  // Open the book.
  await docRow.click();
  await expect(page.getByTestId("reader")).toBeVisible();

  // TOC lists the nav entries.
  const toc = page.getByTestId("toc");
  await expect(toc.getByRole("link", { name: "Chapter One" })).toBeVisible();
  await expect(toc.getByRole("link", { name: "Chapter Two" })).toBeVisible();

  // Cover image is served via a signed asset URL and must actually decode.
  const cover = page.getByTestId("reader-cover");
  await expect(cover).toHaveAttribute("src", /^\/v1\/assets\/.+\?exp=\d+&sig=[A-Za-z0-9_-]+$/);
  await cover.evaluate(async (el) => {
    const img = el as HTMLImageElement;
    if (!img.complete || img.naturalWidth === 0) {
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("cover failed to load"));
      });
    }
  });
  expect(await cover.getAttribute("src")).toBeTruthy();

  // Titlepage is the first spine section.
  const section = page.getByTestId("section");
  await expect(section).toContainText("Night Fixture Book");
  await expect(page.getByTestId("prev-btn")).toBeDisabled();

  // Forward to Chapter One, then to the final chapter.
  await page.getByTestId("next-btn").click();
  await expect(section).toContainText("first chapter begins here");
  await page.getByTestId("next-btn").click();
  await expect(section).toContainText("second and final chapter");
  await expect(page.getByTestId("next-btn")).toBeDisabled();

  // Back navigation works.
  await page.getByTestId("prev-btn").click();
  await expect(section).toContainText("first chapter begins here");

  // =================== Slice 5: URL article ===================
  // Back to the library (same logged-in session — no new code request).
  await page.getByTestId("back-btn").click();
  await expect(page.getByTestId("library")).toBeVisible();

  // Open the add-URL form, type the loopback fixture URL, submit.
  await page.getByTestId("add-url-btn").click();
  await page.getByTestId("add-url-input").fill(ARTICLE_URL);
  await page.getByTestId("add-url-go").click();

  // The article row appears (pending) and the worker flips it to "ready".
  // Title starts as the URL, then the worker rewrites it to the headline.
  const articleRow = page
    .getByTestId("doc-row")
    .filter({ hasText: "Test Article Headline" })
    .first();
  await expect(articleRow).toBeVisible({ timeout: 15_000 });
  await expect(articleRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 60_000 });

  // Open the article.
  await articleRow.click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("reader")).toContainText("Test Article Headline");

  // The extracted body renders (nav/footer junk stripped by Readability).
  const aSection = page.getByTestId("section");
  await expect(aSection).toContainText("lighthouse keeper");
  await expect(aSection).toContainText("coffee queue");
  await expect(aSection).not.toContainText("E2E News");

  // Back to the library to exercise tags.
  await page.getByTestId("back-btn").click();
  await expect(page.getByTestId("library")).toBeVisible();

  // Add a tag to the article via the row's "+ tag" affordance.
  const artRow = page.getByTestId("doc-row-card").filter({ hasText: "Test Article Headline" }).first();
  await artRow.getByTestId("doc-add-tag").click();
  await artRow.getByTestId("doc-tag-input").fill("e2e-article");
  await artRow.getByTestId("doc-tag-input").press("Enter");

  // The tag chip shows on the row.
  await expect(artRow.getByTestId("doc-tag")).toContainText("e2e-article");

  // The tag filter bar now offers the tag; clicking it narrows to the
  // article (the EPUB book has no tags, so it must disappear).
  const chip = page.getByTestId("tag-filter-chip").filter({ hasText: "e2e-article" });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByTestId("doc-row").filter({ hasText: "Test Article Headline" })).toBeVisible();
  await expect(page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" })).toHaveCount(0);

  // "all" restores the full list (both documents).
  await page.getByTestId("tag-filter-all").click();
  await expect(page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" })).toBeVisible();
  await expect(page.getByTestId("doc-row").filter({ hasText: "Test Article Headline" })).toBeVisible();

  // =================== Slice 6: PDF faithful ===================
  // Same logged-in session — the e2e rate-limit budget is 4 request-code
  // calls per run, so a standalone PDF spec (its own login) is not allowed.
  // Upload the outline PDF; the worker flips it to "ready" after reading the
  // original (the browser will render THAT with pdf.js + range requests).
  await page.getByTestId("upload-input").setInputFiles(FIXTURE_PDF);
  const pdfRow = page.getByTestId("doc-row").filter({ hasText: "Night Fixture PDF" }).first();
  await expect(pdfRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 90_000 });

  // Open it — the pdf.js reader, not the section reader.
  await pdfRow.click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-page-count")).toHaveText("2 pages");

  // The PDF outline IS the TOC (two clickable page destinations).
  const pdfToc = page.getByTestId("toc");
  await expect(pdfToc.getByRole("link", { name: "Chapter One" })).toBeVisible();
  await expect(pdfToc.getByRole("link", { name: "Chapter Two" })).toBeVisible();
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 / 2");

  // Outline navigation jumps to the destination page.
  await pdfToc.getByRole("link", { name: "Chapter Two" }).click();
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 / 2");
  await expect(page.getByTestId("prev-btn")).toBeEnabled();
  await expect(page.getByTestId("next-btn")).toBeDisabled();
  await page.getByTestId("prev-btn").click();
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 / 2");

  // Text-layer highlight: select a phrase from page 1's text layer (the
  // same exact-text-node + bubbling-mouseup technique as the epub case —
  // it exercises the app's selection → pdfAnchor → offset path).
  const layer = page.getByTestId("pdf-text-layer");
  await expect(layer).toContainText("first chapter begins here");
  await layer.evaluate(() => {
    const root = document.querySelector("[data-testid='pdf-text-layer']")!;
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    let found: { node: Text; offset: number } | null = null;
    for (const node of nodes) {
      const i = node.data.indexOf("first chapter begins here");
      if (i !== -1) {
        found = { node, offset: i };
        break;
      }
    }
    if (!found) throw new Error("phrase not found in the PDF text layer");
    const range = document.createRange();
    range.setStart(found.node, found.offset);
    range.setEnd(found.node, found.offset + "first chapter begins here".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  const saveBar = page.getByTestId("save-highlight-bar");
  await expect(saveBar).toBeVisible();
  await expect(page.getByTestId("save-highlight-preview")).toContainText("first chapter begins here");
  await page.getByTestId("save-highlight-btn").click();
  const mark = layer.locator("mark[data-testid='hl-mark']").first();
  await expect(mark, { timeout: 15_000 }).toBeVisible();
  await expect(mark).toHaveText("first chapter begins here");

  // Regression (highlight bug, 2026-11): the PDF text layer is transparent —
  // the canvas is the ink. The UA stylesheet gives <mark> black text, which
  // made the highlighted glyphs flip opaque ("the text changes as I
  // highlight"). The mark must stay transparent and the text must not
  // duplicate (no nested marks from double-wrapping).
  await expect(mark).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  expect(await mark.locator("mark").count(), "no nested <mark> after create").toBe(0);

  // Changing a highlight's color is a PATCH: the highlights list refetches
  // over the same DOM. Without the reconciliation pass the effect would
  // re-place marks on top of the existing one (double-wrap) — assert the
  // mark is replaced, not stacked, and the color actually changes.
  await page.getByTestId("highlights-btn").click();
  const panel = page.getByTestId("highlights-panel");
  await expect(panel).toBeVisible();
  await panel.evaluate((root) => {
    const swatches = [...root.querySelectorAll("div,button")].filter(
      (e) => (e as HTMLElement).style.width === "22px" && (e as HTMLElement).style.background,
    );
    const green = swatches.find((e) => /182,\s*240|b6f0b6/i.test((e as HTMLElement).style.background));
    (green ?? swatches[1])!.click();
  });
  await expect(mark).toHaveCSS("background-color", "rgb(182, 240, 182)");
  expect(await layer.locator("mark[data-testid='hl-mark']").count(), "no double-wrap after color patch").toBe(1);
  expect(await mark.locator("mark").count(), "no nested <mark> after color patch").toBe(0);

  // Progress + highlight survive a reload: page 1 is restored (0-based
  // locator) and the <mark> is re-rendered from its stored anchor (in the
  // green the color patch set above).
  await page.getByTestId("highlights-btn").click(); // close the panel
  await page.waitForTimeout(1_200);
  await page.reload();
  await expect(page.getByTestId("signed-in")).toBeVisible({ timeout: 10_000 });
  const pdfRow2 = page.getByTestId("doc-row").filter({ hasText: "Night Fixture PDF" }).first();
  await pdfRow2.click();
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 / 2");
  const mark2 = page.getByTestId("pdf-text-layer").locator("mark[data-testid='hl-mark']").first();
  await expect(mark2, { timeout: 15_000 }).toBeVisible();
  await expect(mark2).toHaveText("first chapter begins here");

  // Deleting the highlight must remove the mark entirely (the effect used
  // to only ever add, never remove).
  await page.getByTestId("highlights-btn").click();
  await page.getByTestId("highlights-panel").getByTestId("delete-highlight-btn").click();
  await expect(page.getByTestId("pdf-text-layer").locator("mark[data-testid='hl-mark']"), { timeout: 15_000 }).toHaveCount(0);

  // Scanned PDF: the worker probes the text layer and flags pdfHasText=
  // false, so the reader shows the clear no-text message (SPECS §2).
  await page.getByTestId("back-btn").click();
  await expect(page.getByTestId("library")).toBeVisible();
  await page.getByTestId("upload-input").setInputFiles(FIXTURE_PDF_SCANNED);
  const scannedRow = page.getByTestId("doc-row").filter({ hasText: "Night Fixture PDF Scanned" }).first();
  await expect(scannedRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 90_000 });
  await scannedRow.click();
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-no-text")).toContainText("no text layer");
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 / 1");
});
