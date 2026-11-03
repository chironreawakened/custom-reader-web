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

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const root = process.env.REPO_ROOT;
  if (!root) throw new Error("REPO_ROOT not set");
  execFileSync("node", ["apps/api/tools/make-fixture-epub.mjs", FIXTURE], { cwd: root });
  // The article fixture is a loopback HTTP server; started here so the CI
  // worker (RDR_ENV=ci, loopback allowed) can fetch it. Idempotent.
  await ensureArticleServer();
});

test("documents: upload fixture, read sections and cover", async ({ page }) => {
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
});
