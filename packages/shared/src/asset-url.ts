/**
 * Signed asset URLs (SPECS §3).
 *
 *   URL: /v1/assets/<asset_id>?exp=<unix_seconds>&sig=<base64url>
 *   sig = HMAC-SHA256(asset-url/v1, "v1|" + asset_id + "|" + user_id + "|" + exp)
 *
 * `exp` is the end of the current 6-hour window + 6 hours, so URLs are stable
 * within a window (cacheable) and live 6–12 h. Verified in constant time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ASSET_URL_LABEL = "asset-url/v1";
export const ASSET_URL_WINDOW_SECONDS = 6 * 3600; // 21600

/** End of the current window + one more window: (floor(now/21600) + 2) * 21600. */
export function nextAssetExp(nowSeconds: number): number {
  return (Math.floor(nowSeconds / ASSET_URL_WINDOW_SECONDS) + 2) * ASSET_URL_WINDOW_SECONDS;
}

export function signAsset(assetId: string, userId: string, exp: number, subkey: Uint8Array): string {
  const payload = `v1|${assetId}|${userId}|${exp}`;
  return createHmac("sha256", subkey).update(payload, "utf8").digest("base64url");
}

/** Constant-time comparison; false on any mismatch (including length). */
export function verifyAsset(assetId: string, userId: string, exp: number, sig: string, subkey: Uint8Array): boolean {
  const expected = signAsset(assetId, userId, exp, subkey);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
