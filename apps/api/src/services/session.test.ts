import { describe, expect, it } from "vitest";
import { newSessionToken, hashToken } from "./session.js";

describe("session tokens", () => {
  it("newSessionToken is 32 random bytes in base64url", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
  });

  it("tokens are unique", () => {
    const seen = new Set(Array.from({ length: 100 }, () => newSessionToken()));
    expect(seen.size).toBe(100);
  });

  it("hashToken is deterministic SHA-256 hex", () => {
    const h = hashToken("abc");
    expect(h).toBe(hashToken("abc"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashing a fresh token does not leak the token", () => {
    const t = newSessionToken();
    expect(hashToken(t)).not.toContain(t);
  });
});
