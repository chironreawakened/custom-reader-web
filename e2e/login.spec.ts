import { test, expect } from "@playwright/test";
import { EMAIL, requestCode, verifyCode } from "./mailbox.js";

// Slice 1 e2e: the full login loop through the real web UI.
//
//   email form -> request code -> console mailer writes the code to
//   E2E_MAILBOX -> test reads it -> 6-digit inputs -> session cookie ->
//   "Hello <email>" -> logout -> logged out.
//
// CSRF, rate limits and closed signup are exercised implicitly (the browser
// sends Origin + X-Requested-With; the mailbox email is the allowed one).
//
// RATE-LIMIT NOTE: the request-code limiter is 5 / 15 min per IP and a
// limited call is answered with a silent 202 (no mail, SPECS §4). The whole
// suite (all specs) must therefore issue at most 4 request-code calls per
// CI run — login(2) + documents(1) + progress(1). Do not add a fifth.

test.describe.configure({ mode: "serial" });

test("login: request code, verify, me, logout", async ({ page }) => {
  const code = await requestCode(page);
  await verifyCode(page, code);

  await expect(page.locator("#hello")).toHaveText(`Hello ${EMAIL}`);

  // Logout revokes the session and returns to the login form.
  await page.getByTestId("logout-btn").click();
  await expect(page.getByTestId("email-input")).toBeVisible();

  // The revoked session must no longer authenticate /v1/me.
  const me = await page.request.get("/v1/me");
  expect(me.status()).toBe(401);
});

test("verify: a wrong code is rejected with the generic 401", async ({ page }) => {
  const code = await requestCode(page);
  const wrong = code === "000000" ? "111111" : "000000";
  const inputs = page.locator('input[inputmode="numeric"]');
  for (let i = 0; i < 6; i++) {
    await inputs.nth(i).fill(wrong[i]!);
  }

  await expect(page.getByTestId("code-error")).toBeVisible();
  await expect(page.getByTestId("signed-in")).toHaveCount(0);
});

