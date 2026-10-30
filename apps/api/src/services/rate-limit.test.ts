import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./rate-limit.js";

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit within the window", () => {
    const l = new SlidingWindowLimiter(3, 60_000);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(false);
  });

  it("tracks keys independently", () => {
    const l = new SlidingWindowLimiter(1, 60_000);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("b").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(false);
  });

  it("frees a slot once the oldest hit leaves the window", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(false);
    // Simulate time passing beyond the window.
    const now = Date.now;
    let offset = 0;
    Date.now = () => now() + (offset += 1100);
    try {
      expect(l.hit("a").allowed).toBe(true);
    } finally {
      Date.now = now;
    }
  });

  it("returns a positive retryAfterSec when blocked", () => {
    const l = new SlidingWindowLimiter(1, 60_000);
    l.hit("a");
    const blocked = l.hit("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("prune() drops keys with no recent activity", () => {
    const l = new SlidingWindowLimiter(1, 1000);
    l.hit("a");
    const now = Date.now;
    let offset = 0;
    Date.now = () => now() + (offset += 2000);
    try {
      l.prune();
      expect(l.hit("a").allowed).toBe(true); // slot freed after prune + window pass
    } finally {
      Date.now = now;
    }
  });
});
