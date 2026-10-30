/**
 * Slice 1 auth API contract (SPECS §4, §12) — shared by the API and the web
 * client. These are the source of the OpenAPI spec (slice 10).
 */
import { z } from "zod";

/**
 * Subkey label for login-code HMAC (SPECS §1). Exported so the API, the
 * break-glass CLI and the unit tests all derive the same subkey.
 */
export const OTP_HMAC_LABEL = "otp-hmac/v1";

const email = z.string().trim().min(1).max(255).toLowerCase();

/** POST /v1/auth/request-code */
export const requestCodeBody = z.object({
  email,
});
export type RequestCodeBody = z.infer<typeof requestCodeBody>;

/** POST /v1/auth/verify-code */
export const verifyCodeBody = z
  .object({
    email,
    /** 6 ASCII digits. */
    code: z.string().regex(/^\d{6}$/),
    client: z.enum(["web", "bearer"]),
  })
  .strict();
export type VerifyCodeBody = z.infer<typeof verifyCodeBody>;

/** GET /v1/me */
export const meResponse = z.object({
  email,
  createdAt: z.string(),
});
export type MeResponse = z.infer<typeof meResponse>;

/** POST /v1/auth/verify-code with client="bearer" */
export const verifyCodeBearerResponse = z.object({
  token: z.string(),
});
export type VerifyCodeBearerResponse = z.infer<typeof verifyCodeBearerResponse>;

/** request-code always returns 202 with no body content that reveals anything. */
export const requestCodeResponse = z.object({
  sent: z.boolean(),
});
export type RequestCodeResponse = z.infer<typeof requestCodeResponse>;

/** Error envelope (SPECS §12). */
export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiError>;
