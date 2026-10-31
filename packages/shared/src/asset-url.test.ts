import { describe, expect, it } from "vitest";
import { ASSET_URL_LABEL, deriveSubkey, nextAssetExp, signAsset, verifyAsset } from "./index.js";

// A fixed master key for frozen vectors (test-only, never real).
const MASTER = Buffer.alloc(32, 7);
const subkey = deriveSubkey(MASTER, ASSET_URL_LABEL);

describe("asset URL signing (SPECS §3)", () => {
  const assetId = "11111111-2222-3333-4444-555555555555";
  const userId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("signs and verifies", () => {
    const exp = 1_800_000_000;
    const sig = signAsset(assetId, userId, exp, subkey);
    expect(verifyAsset(assetId, userId, exp, sig, subkey)).toBe(true);
  });

  it("rejects a different asset, user, or exp", () => {
    const exp = 1_800_000_000;
    const sig = signAsset(assetId, userId, exp, subkey);
    expect(verifyAsset(assetId + "x", userId, exp, sig, subkey)).toBe(false);
    expect(verifyAsset(assetId, userId + "x", exp, sig, subkey)).toBe(false);
    expect(verifyAsset(assetId, userId, exp + 1, sig, subkey)).toBe(false);
  });

  it("rejects tampered / malformed signatures", () => {
    const exp = 1_800_000_000;
    const sig = signAsset(assetId, userId, exp, subkey);
    expect(verifyAsset(assetId, userId, exp, sig.slice(0, -2), subkey)).toBe(false);
    expect(verifyAsset(assetId, userId, exp, "", subkey)).toBe(false);
    const flipped = sig[0] === "A" ? sig[1] + sig.slice(1) : "A" + sig.slice(1);
    expect(verifyAsset(assetId, userId, exp, flipped, subkey)).toBe(false);
  });

  it("rejects a signature from a different subkey", () => {
    const other = deriveSubkey(MASTER, "asset-url/v2");
    const exp = 1_800_000_000;
    const sig = signAsset(assetId, userId, exp, other);
    expect(verifyAsset(assetId, userId, exp, sig, subkey)).toBe(false);
  });

  it("frozen vector (format must never change silently)", () => {
    // exp 1_893_456_000 = 2029-01-01T00:00:00Z. Captured 2026-10-30; if this
    // changes the HMAC construction changed and the spec must be re-read.
    const exp = 1_893_456_000;
    expect(signAsset(assetId, userId, exp, subkey)).toBe("Z_0d8BlwfYDS6TAWWTFDafz_D5XvRxTYqXluC2Lx2m4");
  });

  it("window expiry: (floor(now/21600)+2)*21600, stable within the window", () => {
    // Window W: [W, W+21600). For any now in W, exp = W + 2*21600.
    const W = 1_800_000_000 - (1_800_000_000 % 21_600);
    for (const now of [W, W + 1, W + 21_599]) {
      expect(nextAssetExp(now)).toBe(W + 2 * 21_600);
    }
    expect(nextAssetExp(W + 21_600)).toBe(W + 3 * 21_600);
  });
});
