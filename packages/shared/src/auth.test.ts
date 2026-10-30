import { describe, expect, it } from "vitest";
import { requestCodeBody, verifyCodeBody, meResponse } from "./auth.js";

describe("requestCodeBody", () => {
  it("accepts and normalizes a valid email", () => {
    const r = requestCodeBody.parse({ email: "  A@B.c " });
    expect(r.email).toBe("a@b.c");
  });

  it("rejects empty / missing email", () => {
    expect(requestCodeBody.safeParse({}).success).toBe(false);
    expect(requestCodeBody.safeParse({ email: "" }).success).toBe(false);
  });
});

describe("verifyCodeBody", () => {
  it("accepts a well-formed body", () => {
    expect(verifyCodeBody.parse({ email: "a@b.c", code: "123456", client: "web" })).toBeTruthy();
    expect(verifyCodeBody.parse({ email: "a@b.c", code: "123456", client: "bearer" })).toBeTruthy();
  });

  it("rejects bad codes, unknown client and extra fields", () => {
    expect(verifyCodeBody.safeParse({ email: "a@b.c", code: "12345", client: "web" }).success).toBe(false);
    expect(verifyCodeBody.safeParse({ email: "a@b.c", code: "123456", client: "ios" }).success).toBe(false);
    expect(
      verifyCodeBody.safeParse({ email: "a@b.c", code: "123456", client: "web", extra: 1 }).success
    ).toBe(false);
  });
});

describe("meResponse", () => {
  it("shapes the /me payload", () => {
    const m = meResponse.parse({ email: "a@b.c", createdAt: "2026-10-30T00:00:00.000Z" });
    expect(m.email).toBe("a@b.c");
    expect(meResponse.safeParse({ email: "a@b.c" }).success).toBe(false);
  });
});
