import { test, expect } from "@playwright/test";
import { login } from "./mailbox.js";

// Slice 3 e2e: reading progress + reader prefs survive a page reload.
//
//   login (console mailbox) -> library -> open the fixture book (uploaded by
//   documents.spec.ts, suite runs serially) -> jump to "Chapter One" via the
//   TOC (autosave stores the section locator) -> reload the page -> reopen
//   the book -> assert we land on Chapter One again, not the title page.
//   Then switch the reader theme and assert it survives a reload too.
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
});
