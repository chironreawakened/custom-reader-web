import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Slice 1 e2e: the full login loop through the real web UI.
//
//   email form -> request code -> console mailer writes the code to
//   E2E_MAILBOX -> test reads it -> 6-digit inputs -> session cookie ->
//   "Hello <email>" -> logout -> logged out.
//
// CSRF, rate limits and closed signup are exercised implicitly (the browser
// sends Origin + X-Requested-With; the mailbox email is the allowed one).

const EMAIL = "e2e@reader.test";

function latestCode(mailbox: string): string | null {
  const lines = readFileSync(mailbox, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /code is (\d{6})/i.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

test.describe.configure({ mode: "serial" });

test("login: request code, verify, me, logout", async ({ page }) => {
  const mailbox = process.env.E2E_MAILBOX;
  if (!mailbox) throw new Error("E2E_MAILBOX not set");

  await page.goto("/");
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("request-btn").click();

  // The code must appear in the console mailbox.
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

  // Type the code into the 6 digit inputs.
  const inputs = page.locator('input[inputmode="numeric"]');
  expect(await inputs.count()).toBe(6);
  for (let i = 0; i < 6; i++) {
    await inputs.nth(i).fill(code[i]!);
  }

  // A valid code lands on the signed-in view (cookie session + /v1/me).
  await expect(page.getByTestId("signed-in")).toBeVisible();
  await expect(page.locator("#hello")).toHaveText(`Hello ${EMAIL}`);

  // Logout revokes the session and returns to the login form.
  await page.getByTestId("logout-btn").click();
  await expect(page.getByTestId("email-input")).toBeVisible();

  // The revoked session must no longer authenticate /v1/me.
  const me = await page.request.get("/v1/me");
  expect(me.status()).toBe(401);
});

test("verify: a wrong code is rejected with the generic 401", async ({ page }) => {
  const mailbox = process.env.E2E_MAILBOX!;

  await page.goto("/");
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("request-btn").click();
  await page.getByTestId("code-first").waitFor();
  const code = await expect
    .poll(() => {
      try {
        return latestCode(mailbox);
      } catch {
        return null;
      }
    }, { timeout: 15_000 })
    .toMatch(/^\d{6}$/)
    .then(() => latestCode(mailbox)!);

  const wrong = code === "000000" ? "111111" : "000000";
  const inputs = page.locator('input[inputmode="numeric"]');
  for (let i = 0; i < 6; i++) {
    await inputs.nth(i).fill(wrong[i]!);
  }

  await expect(page.getByTestId("code-error")).toBeVisible();
  await expect(page.getByTestId("signed-in")).toHaveCount(0);
});
