import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

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

const EMAIL = "e2e@reader.test";

function mailboxLines(): string[] {
  try {
    return readFileSync(process.env.E2E_MAILBOX!, "utf8").split("\n");
  } catch {
    return [];
  }
}

function latestCodeSince(mailbox: string, baseline: number): string | null {
  const lines = readFileSync(mailbox, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= baseline; i--) {
    const m = /code is (\d{6})/i.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

async function login(page: Page): Promise<void> {
  const mailbox = process.env.E2E_MAILBOX;
  if (!mailbox) throw new Error("E2E_MAILBOX not set");
  const baseline = mailboxLines().length;

  await page.goto("/");
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("request-btn").click();
  await page.getByTestId("code-first").waitFor();
  const code = await expect
    .poll(() => {
      try {
        return latestCodeSince(mailbox, baseline);
      } catch {
        return null;
      }
    }, { timeout: 15_000, message: "code never reached the console mailbox" })
    .toMatch(/^\d{6}$/)
    .then(() => latestCodeSince(mailbox, baseline)!);
  const inputs = page.locator('input[inputmode="numeric"]');
  for (let i = 0; i < 6; i++) {
    await inputs.nth(i).fill(code[i]!);
  }
  await expect(page.getByTestId("signed-in")).toBeVisible({ timeout: 10_000 });
}

test.describe.configure({ mode: "serial" });

test("progress + prefs: saved section and theme survive a reload", async ({ page }) => {
  await login(page);

  // Open the fixture book (uploaded by documents.spec.ts earlier in the run).
  const docRow = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await expect(docRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 30_000 });
  await docRow.click();
  await expect(page.getByTestId("reader")).toBeVisible();

  // Title page is the default landing section.
  const section = page.getByTestId("section");
  await expect(section).toContainText("Night Fixture Book");

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
