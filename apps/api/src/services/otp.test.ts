import { describe, expect, it } from "vitest";
import { codeHmac } from "./otp.js";

describe("codeHmac", () => {
  const subkey = Buffer.alloc(32, 7);

  it("is deterministic for the same inputs", () => {
    const a = codeHmac(subkey, "user-1", "123456");
    const b = codeHmac(subkey, "user-1", "123456");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when the code, user or subkey differ", () => {
    const base = codeHmac(subkey, "user-1", "123456");
    expect(codeHmac(subkey, "user-1", "123457")).not.toBe(base);
    expect(codeHmac(subkey, "user-2", "123456")).not.toBe(base);
    expect(codeHmac(Buffer.alloc(32, 8), "user-1", "123456")).not.toBe(base);
  });

  it("never contains the plaintext code", () => {
    const h = codeHmac(subkey, "user-1", "000000");
    expect(h).not.toContain("000000");
  });
});
