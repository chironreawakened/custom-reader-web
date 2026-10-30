/**
 * Break-glass CLI (PLAN §Users/auth): prints a valid login code and emails it
 * to the owner. Use when you can't receive the emailed code (e.g. SMTP is down).
 *
 *   docker compose exec api node dist/cli.js login-code
 *
 * Uses the same OTP path as the API: the code is stored as its HMAC and becomes
 * the active code for ALLOWED_EMAIL (invalidating older ones).
 */
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/client.js";
import { users, type User } from "./db/schema.js";
import { deriveSubkey, OTP_HMAC_LABEL } from "@reader/shared";
import { createMailer } from "./services/mailer.js";
import { requestCode, findUserByEmail } from "./services/otp.js";

async function main() {
  const [, , cmd] = process.argv;
  if (cmd !== "login-code") {
    console.error("usage: node dist/cli.js login-code");
    process.exit(2);
  }
  const cfg = loadConfig();
  const otpSubkey = deriveSubkey(cfg.masterKey, OTP_HMAC_LABEL);
  const db = getDb();

  let user = await findUserByEmail({ db }, cfg.allowedEmail);
  if (!user) {
    const created = await db.insert(users).values({ id: crypto.randomUUID(), email: cfg.allowedEmail }).returning();
    // eslint-disable-next-line no-console
    console.log(`[cli] created user for ${cfg.allowedEmail}`);
    user = created[0]!;
  }
  await finish(cfg, otpSubkey, user);
}

async function finish(
  cfg: ReturnType<typeof loadConfig>,
  otpSubkey: Buffer,
  user: User,
) {
  const db = getDb();
  const { code } = await requestCode({ db, otpSubkey }, user, "break-glass-cli");
  const mailer = await createMailer(cfg);
  try {
    await mailer.send(cfg.allowedEmail, "Your Personal Reader code (break-glass)", `Your login code is ${code}. It expires in 10 minutes.`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[cli] WARNING: could not email the code: ${String(e)}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[cli] break-glass code for ${cfg.allowedEmail}: ${code}`);
  await closeDb();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[cli] error:", e);
  process.exit(1);
});
