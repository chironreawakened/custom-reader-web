import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsoleMailer, extractCode } from "./mailer.js";

describe("extractCode", () => {
  it("reads the 6-digit code from a mail body", () => {
    expect(extractCode("Your login code is 123456. It expires in 10 minutes.")).toBe("123456");
    expect(extractCode("CODE IS 000000")).toBe("000000");
  });

  it("returns null when there is no code", () => {
    expect(extractCode("no code here")).toBeNull();
    expect(extractCode("code is 12345")).toBeNull();
  });
});

describe("createConsoleMailer", () => {
  let dir: string;
  let mailbox: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reader-mail-"));
    mailbox = join(dir, "mailbox.log");
    process.env.CONSOLE_MAILBOX = mailbox;
  });

  afterEach(async () => {
    delete process.env.CONSOLE_MAILBOX;
    await rm(dir, { recursive: true, force: true });
  });

  it("appends each sent message to the mailbox file", async () => {
    const m = createConsoleMailer();
    await m.send("a@b.c", "Subj", "Your login code is 246810.");
    await m.send("a@b.c", "Subj2", "Your login code is 135790.");
    const text = await readFile(mailbox, "utf8");
    expect(text).toContain("to=a@b.c");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(extractCode(lines[0]!)).toBe("246810");
    expect(extractCode(lines.at(-1)!)).toBe("135790"); // last code
  });
});
