/**
 * In-memory sliding-window rate limiter (SPECS §4).
 *
 * Single-process (one api container), so in-memory is correct here; counters
 * reset on restart, which is acceptable for a single-user app. Keys are
 * arbitrary strings (ip, ip+":"+email, etc.).
 */
export interface RateCheck {
  allowed: boolean;
  /** seconds until a slot frees up (only meaningful when !allowed). */
  retryAfterSec: number;
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string): RateCheck {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    let arr = this.hits.get(key);
    if (!arr) {
      arr = [];
      this.hits.set(key, arr);
    }
    // drop expired entries
    while (arr.length && arr[0]! <= windowStart) arr.shift();

    if (arr.length >= this.limit) {
      // retry after the oldest entry in the window expires
      const oldest = arr[0]!;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }
    arr.push(now);
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Drop keys with no recent activity (keeps the map bounded). */
  prune(): void {
    const windowStart = Date.now() - this.windowMs;
    for (const [k, v] of this.hits) {
      const fresh = v.filter((t) => t > windowStart);
      if (fresh.length === 0) this.hits.delete(k);
      else this.hits.set(k, fresh);
    }
  }
}
