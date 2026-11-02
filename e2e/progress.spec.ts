import { test, expect } from "@playwright/test";
import { login } from "./mailbox.js";

// Slice 3 + 4 e2e: reading progress + reader prefs survive a page reload,
// AND highlights (slice 4) work end to end:
//
//   login (console mailbox) -> library -> open the fixture book (uploaded by
//   documents.spec.ts, suite runs serially) -> jump to "Chapter One" via the
//   TOC (autosave stores the section locator) -> reload the page -> reopen
//   the book -> assert we land on Chapter One again, not the title page.
//   Then switch the reader theme and assert it survives a reload too.
//
//   Slice 4 (same logged-in session — the e2e rate-limit budget is 4
//   request-code calls per run, so no extra login here): select text across
//   the paragraph break in Chapter One -> save -> assert a <mark> appears
//   covering BOTH paragraphs -> reload + reopen -> assert the mark is
//   re-rendered from the stored anchor -> open the highlights panel ->
//   recolor to green, add a note, verify the Markdown export contains the
//   exact text and the note -> delete -> assert item and mark are gone.
//
// NOTE: logs in as the single ALLOWED_EMAIL with single-use codes, so the
// suite must run serially (workers: 1 in the config).

test.describe.configure({ mode: "serial" });

test("progress + prefs: saved section and theme survive a reload", async ({ page }) => {
  await login(page);

  // Open the fixture book (uploaded by documents.spec.ts earlier in the run).
  const docRow = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await expect(docRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 30_000 });
  await docRow.click();
  await expect(page.getByTestId("reader")).toBeVisible();

  // A section renders (fresh login lands on the first spine section;
  // whatever that is, the restore assertion below is the point of the test).
  const section = page.getByTestId("section");
  await expect(section).toBeVisible();

  // Jump to Chapter One via the TOC — the reader autosaves the locator.
  await page.getByTestId("toc").getByRole("link", { name: "Chapter One" }).click();
  await expect(section).toContainText("first chapter begins here");

  // Give the debounced autosave time to hit the API before reloading.
  await page.waitForTimeout(1_200);
  await page.reload();

  // Signed-in state persists (httpOnly cookie); back to the library.
  await expect(page.getByTestId("signed-in")).toBeVisible({ timeout: 10_000 });
  const row2 = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await row2.click();
  await expect(page.getByTestId("reader")).toBeVisible();

  // We must land on Chapter One again — not the title page.
  const section2 = page.getByTestId("section");
  await expect(section2).toContainText("first chapter begins here", { timeout: 15_000 });
  await expect(section2).not.toContainText("by Tessa Tester");

  // Theme preference: switch to dark, verify applied, reload, verify kept.
  await page.getByTestId("theme-select").selectOption("dark");
  await expect(page.getByTestId("reader")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(1_000);
  await page.reload();
  const row3 = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await row3.click();
  await expect(page.getByTestId("reader")).toHaveAttribute("data-theme", "dark", { timeout: 15_000 });
  // And progress persisted across this second reload as well.
  await expect(page.getByTestId("section")).toContainText("first chapter begins here", { timeout: 15_000 });

  // ---- Slice 4: highlights ----------------------------------------------------
  // Same session (the e2e budget is 4 request-code calls per run — no second
  // login). Chapter One is rendered; no highlights exist yet in this run.
  const section4 = page.getByTestId("section");
  await expect(section4.locator("mark[data-testid='hl-mark']")).toHaveCount(0);

  // Select "first chapter begins here…" → "…at night." — a range that spans
  // the paragraph break between the two <p>s of the chapter. The selection
  // is built on exact text nodes (deterministic offsets) and released with a
  // real bubbling mouseup, so the app's own selection→anchor path runs.
  await section.evaluate(() => {
    const article = document.querySelector("[data-testid='section']")!;
    const nodes: { node: Text }[] = [];
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n as Text });
    }
    const find = (s: string) => {
      for (const { node } of nodes) {
        const i = node.data.indexOf(s);
        if (i !== -1) return { node, offset: i };
      }
      throw new Error(`text not found: ${s}`);
    };
    const a = find("first chapter begins here");
    const b = find("at night.");
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset + "at night.".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector("#content")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  // The floating save bar shows the selection preview (first 80 chars — it
  // crosses into the second paragraph at the block separator).
  const bar = page.getByTestId("save-highlight-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("save-highlight-preview")).toContainText("first chapter begins here");
  await expect(page.getByTestId("save-highlight-preview")).toContainText("Second para");
  await expect(page.getByTestId("save-highlight-preview")).not.toContainText("The first");

  // Save it.
  await page.getByTestId("save-highlight-btn").click();

  // A <mark> is drawn in EACH covered paragraph (cross-paragraph highlight).
  // Chapter One has exactly two <p> (an <h2> and an <img> come after).
  const marks = section.locator("mark[data-testid='hl-mark']");
  await expect(marks.first()).toBeVisible();
  await expect(section.locator("p mark[data-testid='hl-mark']")).toHaveCount(2, { timeout: 15_000 });
  // The selection starts at "first" (not at the paragraph start), so the
  // first mark covers the paragraph from "first" to its end.
  await expect(section.locator("p").nth(0).locator("mark[data-testid='hl-mark']")).toHaveText(
    "first chapter begins here. It has some words for the word count.",
  );
  await expect(section.locator("p").nth(1).locator("mark[data-testid='hl-mark']")).toHaveText(
    "Second paragraph: foxes jump over lazy dogs at night.",
  );

  // Reload + reopen: the highlight must re-render from its stored anchor.
  await page.reload();
  await expect(page.getByTestId("signed-in")).toBeVisible({ timeout: 10_000 });
  const row4 = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await row4.click();
  await expect(page.getByTestId("reader")).toBeVisible();
  const section3 = page.getByTestId("section");
  await expect(section3).toContainText("first chapter begins here", { timeout: 15_000 });
  await expect(section3.locator("p mark[data-testid='hl-mark']")).toHaveCount(2, { timeout: 15_000 });
  await expect(section3.locator("p").nth(1).locator("mark[data-testid='hl-mark']")).toHaveText(
    "Second paragraph: foxes jump over lazy dogs at night.",
  );

  // Highlights panel: the saved item is listed.
  await page.getByTestId("highlights-btn").click();
  const panel = page.getByTestId("highlights-panel");
  await expect(panel).toBeVisible();
  const item = panel.getByTestId("highlight-item");
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("highlight-text")).toContainText("first chapter begins here");
  await expect(item.getByTestId("highlight-text")).toContainText("at night");
  await expect(item).toHaveAttribute("data-orphaned", "false");

  // Recolor to green → the in-text mark follows the stored colour.
  await item.getByTestId("color-btn-green").click();
  await expect(item.getByTestId("color-btn-green")).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  const bg = await section4
    .locator("mark[data-testid='hl-mark']")
    .first()
    .evaluate((el) => getComputedStyle(el as HTMLElement).backgroundColor);
  expect(bg).toBe("rgb(182, 240, 182)");

  // Add a note (Enter commits) → the note rides on the mark's title.
  await item.getByTestId("note-input").fill("a e2e note");
  await page.keyboard.press("Enter");
  await expect(section3.locator("mark[data-testid='hl-mark']").first()).toHaveAttribute("title", "a e2e note", {
    timeout: 15_000,
  });

  // Markdown export (cookie-authed; the link's own query string carries the
  // documentId): exact text with the paragraph break flattened, the colour
  // tag, the section title, and the note.
  const href = (await panel.getByTestId("export-highlights-btn").getAttribute("href"))!;
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  const md = await res.text();
  expect(md).toContain("# Night Fixture Book");
  expect(md).toContain(
    "> [Green] first chapter begins here. It has some words for the word count. " +
      "Second paragraph: foxes jump over lazy dogs at night.",
  );
  expect(md).toContain("> — Chapter One");
  expect(md).toContain("> Note: a e2e note");

  // Delete → the item disappears AND the in-text mark is cleared.
  await item.getByTestId("delete-highlight-btn").click();
  await expect(panel.getByTestId("highlight-item")).toHaveCount(0, { timeout: 15_000 });
  await expect(section3.locator("mark[data-testid='hl-mark']")).toHaveCount(0);
});
