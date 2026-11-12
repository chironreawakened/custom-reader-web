import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { login } from "./mailbox.js";

// Slice 8 e2e (SPECS §9): full-text search through the real UI.
//
//   login (console mailbox) -> upload an ENGLISH fixture book + a FINNISH
//   fixture book (FIXTURE_LANG=fi) -> the CI worker parses both and indexes
//   their section vectors WITH EACH DOCUMENT'S OWN FTS CONFIG -> search:
//
//     1. "foxes"    -> hits the English book (english config indexes it)
//     2. "kissat"   -> hits the Finnish book even though the book's own text
//        is "kissa" — proves the finnish stemmer ran (kissa/kissat -> "kis").
//        A regression to the old `simple` config would index the raw word
//        "kissa" and this query would match nothing.
//     3. nonsense   -> zero results
//     4. section deep-link: a section hit opens the document AT that section
//     5. highlights: a saved highlight's text surfaces in the highlights list
//
// Same rate-limit budget as the other specs: one login in this file
// (CI AUTH_REQCODE_IP_LIMIT=10; the suite currently does six logins total).
// Specs share one user + one database; this file uploads its own books and
// only asserts on text unique to its fixtures.

const FIXTURE_EN = "/tmp/e2e-search-en.epub";
const FIXTURE_FI = "/tmp/e2e-search-fi.epub";

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeAll(async () => {
  const root = process.env.REPO_ROOT;
  if (!root) throw new Error("REPO_ROOT not set");
  execFileSync("node", ["apps/api/tools/make-fixture-epub.mjs", FIXTURE_EN], { cwd: root });
  execFileSync("node", ["apps/api/tools/make-fixture-epub.mjs", FIXTURE_FI], {
    cwd: root,
    env: { ...process.env, FIXTURE_LANG: "fi" },
  });
});

test("search: english + finnish stemming, empty, deep-link, highlights", async ({ page }) => {
  await login(page);

  // Upload both fixture books; the worker parses each and flips it "ready".
  await page.getByTestId("upload-input").setInputFiles(FIXTURE_EN);
  const enRow = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await expect(enRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 90_000 });

  await page.getByTestId("upload-input").setInputFiles(FIXTURE_FI);
  const fiRow = page.getByTestId("doc-row").filter({ hasText: "Yökirja" }).first();
  await expect(fiRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 90_000 });

  // ---- 1. english config: "foxes" hits the English book --------------------
  // NOTE: specs share one user + one DB (serial run), and earlier specs
  // already uploaded their own "Night Fixture Book" — so a "foxes" search may
  // surface SEVERAL matching English doc/section hits. Assert on the first
  // (existence), never an exact count of the shared fixture.
  await page.getByTestId("search-input").fill("foxes");
  await page.getByTestId("search-btn").click();
  const results = page.getByTestId("search-results");
  await expect(results.getByTestId("search-doc-hit").filter({ hasText: "Night Fixture Book" }).first()).toBeVisible({ timeout: 15_000 });
  await expect(results.getByTestId("search-section-hit").filter({ hasText: "Night Fixture Book" }).first()).toBeVisible();
  // The Finnish book must NOT match an english word (uniquely ours → exact 0).
  await expect(results.getByTestId("search-doc-hit").filter({ hasText: "Yökirja" })).toHaveCount(0);

  // ---- 2. finnish config: "kissat" hits the Finnish book (stem kis) ---------
  await page.getByTestId("search-input").fill("kissat");
  await page.getByTestId("search-btn").click();
  await expect(results.getByTestId("search-doc-hit").filter({ hasText: "Yökirja" })).toBeVisible({ timeout: 15_000 });
  await expect(results.getByTestId("search-section-hit")).toContainText("Yökirja");
  // ...and only the Finnish book.
  await expect(results.getByTestId("search-doc-hit").filter({ hasText: "Night Fixture Book" })).toHaveCount(0);

  // ---- 3. nonsense: zero results --------------------------------------------
  await page.getByTestId("search-input").fill("zzqxwvzz");
  await page.getByTestId("search-btn").click();
  await expect(results.getByTestId("search-results-count")).toContainText("0 results for “zzqxwvzz”", { timeout: 15_000 });
  await expect(results.getByTestId("search-doc-hit")).toHaveCount(0);

  // ---- 4. deep-link: a section hit opens the document at that section -------
  await page.getByTestId("search-input").fill("kissat");
  await page.getByTestId("search-btn").click();
  const sectionHit = results.getByTestId("search-section-hit").filter({ hasText: "Yökirja" }).first();
  await expect(sectionHit).toBeVisible({ timeout: 15_000 });
  await sectionHit.click();
  // The reader lands directly on the matching chapter ("Luku Yksi" holds the
  // kissa/kissat sentences — the titlepage and "Luku Kaksi" do not).
  const section = page.getByTestId("section");
  await expect(section).toContainText("Kissa istuu matolla", { timeout: 15_000 });
  await page.getByTestId("back-btn").click();
  await expect(page.getByTestId("library")).toBeVisible();

  // ---- 5. highlights: a saved highlight surfaces in the highlights list ----
  // Select "foxes jump over lazy dogs" in the English book's Chapter One
  // (same TreeWalker technique as progress.spec) and save it as a highlight.
  // A fresh open lands on the titlepage, so jump to Chapter One via the TOC.
  await enRow.click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await page.getByTestId("toc").getByRole("link", { name: "Chapter One" }).click();
  await expect(page.getByTestId("section")).toContainText("foxes jump over lazy dogs");
  await page.getByTestId("section").evaluate(() => {
    const article = document.querySelector("[data-testid='section']")!;
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    let found: { node: Text; offset: number } | null = null;
    for (const node of nodes) {
      const i = node.data.indexOf("foxes jump over lazy dogs");
      if (i !== -1) {
        found = { node, offset: i };
        break;
      }
    }
    if (!found) throw new Error("phrase not found in section text");
    const range = document.createRange();
    range.setStart(found.node, found.offset);
    range.setEnd(found.node, found.offset + "foxes jump over lazy dogs".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    article.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  const saveBar = page.getByTestId("save-highlight-bar");
  await expect(saveBar).toBeVisible();
  await page.getByTestId("save-highlight-btn").click();
  await expect(page.getByTestId("section").locator("mark[data-testid='hl-mark']")).toContainText(
    "foxes jump over lazy dogs",
    { timeout: 15_000 },
  );

  // Back to the library; "lazy" (only present in that highlight's sentence)
  // must surface a highlights hit with the exact saved text.
  await page.getByTestId("back-btn").click();
  await expect(page.getByTestId("library")).toBeVisible();
  await page.getByTestId("search-input").fill("lazy");
  await page.getByTestId("search-btn").click();
  await expect(results.getByTestId("search-highlight-hit").filter({ hasText: "foxes jump over lazy dogs" })).toBeVisible({ timeout: 15_000 });
});
