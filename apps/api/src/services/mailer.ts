import { appendFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";

/**
 * Mailer interface (PLAN: codes are sent via Gmail SMTP in prod, behind this
 * interface; a console mailer is used in CI/e2e).
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

/** Reads a 6-digit login code out of a mail body (test / break-glass helper). */
export function extractCode(body: string): string | null {
  const m = /code is (\d{6})/i.exec(body);
  return m?.[1] ?? null;
}
export interface SmtpMailerOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** Gmail SMTP mailer. nodemailer is resolved at runtime (production only). */
export async function createSmtpMailer(opts: SmtpMailerOptions): Promise<Mailer> {
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.port === 465,
    auth: { user: opts.user, pass: opts.pass },
  });
  return {
    async send(to, subject, body) {
      await transport.sendMail({ from: opts.user, to, subject, text: body });
    },
  };
}

/**
 * Console mailer: appends each message to a mailbox file (or stdout) instead of
 * sending SMTP. Used by CI/e2e so the test can read the code without a real
 * mailbox. `CONSOLE_MAILBOX` env selects the file; without it, messages go to
 * the process log.
 */
export function createConsoleMailer(): Mailer {
  return {
    async send(to, subject, body) {
      const line = `[${new Date().toISOString()}] to=${to} subject="${subject}" | ${body}\n`;
      const mailbox = process.env.CONSOLE_MAILBOX;
      if (mailbox) await appendFile(mailbox, line, "utf8");
      else {
        // eslint-disable-next-line no-console
        console.log(`[console-mailer] ${line.trimEnd()}`);
      }
    },
  };
}

/**
 * Build the production mailer from config. `smtp` is required for the
 * `smtp` variant; `console` needs nothing.
 */
export async function createMailer(config: AppConfig): Promise<Mailer> {
  if (config.mailer === "console") return createConsoleMailer();
  return createSmtpMailer({
    host: config.smtp!.host,
    port: config.smtp!.port,
    user: config.smtp!.user,
    pass: config.smtp!.pass,
  });
}
