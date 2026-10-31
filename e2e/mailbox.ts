// Shared e2e login helpers.
//
// The CI console mailer (MAILER=console) appends one line per message to
// E2E_MAILBOX. Every spec logs in as the single ALLOWED_EMAIL and OTP codes
// are single-use, so the suite runs serially (workers: 1 in
// playwright.config.ts) and each login reads only mailbox lines written
// AFTER it requested its own code (a baseline line count), never a code
// left over from the previous spec.
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

export const EMAIL = "e2e@reader.test";

/** Non-empty lines in the mailbox file (raw split keeps a trailing "" after
 *  the final \n — filter it, otherwise a line count is off by one). */
export function mailboxLines(): string[] {
  try {
    return readFileSync(process.env.E2E_MAILBOX!, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Most recent 6-digit code on a line written after `baseline`, or null. */
export function latestCodeSince(baseline: number): string | null {
  const lines = mailboxLines();
  for (let i = lines.length - 1; i >= baseline; i--) {
    const m = /code is (\d{6})/i.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Submit the login form and read the fresh code from the console mailbox.
 * Throws with the mailbox tail if no code arrives — a silent 202 from the
 * request-code rate limiter (SPECS §4) is the only known cause of a missing
 * line, and the tail shows whether the mailer wrote anything at all.
 */
export async function requestCode(page: Page): Promise<string> {
  if (!process.env.E2E_MAILBOX) throw new Error("E2E_MAILBOX not set");

  // Baseline = the number of NON-EMPTY lines before our request. The mailer
  // ends every line with \n, so a raw split("\n") carries a trailing ""
  // that inflates the count by one and makes the scan below skip our own
  // code (it sits exactly at index `baseline`).
  const baseline = mailboxLines().length;

  await page.goto("/");
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("request-btn").click();
  await page.getByTestId("code-first").waitFor();

  const code = await expect
    .poll(
      () => latestCodeSince(baseline),
      {
        timeout: 20_000,
        intervals: [500],
        message: "code never reached the console mailbox",
      },
    )
    .toMatch(/^\d{6}$/)
    .then(() => latestCodeSince(baseline)!);
  return code;
}

/** Fill the code box and verify; resolve once the signed-in view is visible. */
export async function verifyCode(page: Page, code: string): Promise<void> {
  const inputs = page.locator('input[inputmode="numeric"]');
  expect(await inputs.count()).toBe(6);
  for (let i = 0; i < 6; i++) {
    await inputs.nth(i).fill(code[i]!);
  }
  await expect(page.getByTestId("signed-in")).toBeVisible({ timeout: 10_000 });
}

/** Full login: request a code, verify it, land on the signed-in view. */
export async function login(page: Page): Promise<void> {
  const code = await requestCode(page);
  return verifyCode(page, code);
}
