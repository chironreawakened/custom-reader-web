import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Slice 2 e2e: upload an EPUB through the real UI and read it back.
//
//   login (console mailbox) -> library -> upload fixture.epub via the file
//   input -> wait for the "ready" badge (the CI worker parses the book) ->
//   open the book -> assert TOC, cover image (signed asset URL), section
//   text and prev/next navigation.
//
// The fixture book is generated with apps/api/tools/make-fixture-epub.mjs so
// CI doesn't ship a binary in the repo. REPO_ROOT must point at the repo.

const EMAIL = "e2e@reader.test";
const FIXTURE = "/tmp/e2e-fixture.epub";

function latestCode(mailbox: string): string | null {
  const lines = readFileSync(mailbox, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /code is (\d{6})/i.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

async function login(page: Page): Promise<void> {
  const mailbox = process.env.E2E_MAILBOX;
  if (!mailbox) throw new Error("E2E_MAILBOX not set");

  await page.goto("/");
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("request-btn").click();
  await page.getByTestId("code-first").waitFor();
  await expect
    .poll(() => {
      try {
        return latestCode(mailbox);
      } catch {
        return null;
      }
    }, { timeout: 15_000, message: "code never reached the console mailbox" })
    .toMatch(/^\d{6}$/);
  const code = latestCode(mailbox)!;
  const inputs = page.locator('input[inputmode="numeric"]');
  for (let i = 0; i < 6; i++) {
    await inputs.nth(i).fill(code[i]!);
  }
  await expect(page.getByTestId("signed-in")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  const root = process.env.REPO_ROOT;
  if (!root) throw new Error("REPO_ROOT not set");
  execFileSync("node", ["apps/api/tools/make-fixture-epub.mjs", FIXTURE], { cwd: root });
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
});
