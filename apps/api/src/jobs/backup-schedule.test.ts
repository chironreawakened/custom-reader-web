import { describe, expect, it } from "vitest";
import { backupKindFor, helsinkiWeekday } from "./backup-schedule.js";

/**
 * The nightly backup cron is `0 3 * * *` Europe/Helsinki.
 *
 * Verification (2026-10-31, node Intl.DateTimeFormat): Helsinki 03:00 is
 * 01:00 UTC in EET and 00:00 UTC in EEST — i.e. the SAME UTC calendar day,
 * so `getUTCDay()` at firing time happens to equal the Helsinki weekday.
 * The handoff's "kind is always daily" bug report was based on the wrong
 * offset math (it claimed Monday 03:00 EET = Sunday UTC; it is Monday
 * 01:00 UTC). The refactor to Helsinki-derived weekdays is kept anyway:
 * it makes the intent explicit and stops relying on the cron hour staying
 * at/after the UTC offset (e.g. a 00:30 EET run WOULD diverge).
 */

describe("helsinkiWeekday", () => {
  it("derives the weekday in Europe/Helsinki, not UTC", () => {
    // 2026-11-01 01:00 UTC = Sunday 03:00 Helsinki (EET, +2)
    expect(helsinkiWeekday(new Date("2026-11-01T01:00:00Z"))).toBe(0);
    // 2026-11-02 01:00 UTC = Monday 03:00 Helsinki
    expect(helsinkiWeekday(new Date("2026-11-02T01:00:00Z"))).toBe(1);
    // 2026-11-07 01:00 UTC = Saturday 03:00 Helsinki
    expect(helsinkiWeekday(new Date("2026-11-07T01:00:00Z"))).toBe(6);
  });

  it("tracks DST (EEST, UTC+3) in summer", () => {
    // 2026-07-05 00:00 UTC = Sunday 03:00 Helsinki
    expect(helsinkiWeekday(new Date("2026-07-05T00:00:00Z"))).toBe(0);
    // 2026-07-06 00:00 UTC = Monday 03:00 Helsinki
    expect(helsinkiWeekday(new Date("2026-07-06T00:00:00Z"))).toBe(1);
  });
});

describe("backupKindFor", () => {
  it("the Monday 03:00 Helsinki firing is weekly", () => {
    // Winter (EET): Helsinki Mon 2026-11-02 03:00 = Mon 2026-11-02 01:00 UTC.
    expect(backupKindFor(new Date("2026-11-02T01:00:00Z"))).toBe("weekly");
    // Summer (EEST): Helsinki Mon 2026-07-06 03:00 = Mon 2026-07-06 00:00 UTC.
    expect(backupKindFor(new Date("2026-07-06T00:00:00Z"))).toBe("weekly");
  });

  it("every other Helsinki firing day is daily", () => {
    // Helsinki Sun 03:00 (EET)
    expect(backupKindFor(new Date("2026-11-01T01:00:00Z"))).toBe("daily");
    // Helsinki Tue 03:00 (EET)
    expect(backupKindFor(new Date("2026-11-03T01:00:00Z"))).toBe("daily");
    // Helsinki Sat 03:00 (EET)
    expect(backupKindFor(new Date("2026-11-07T01:00:00Z"))).toBe("daily");
    // Helsinki Sat 03:00 (EEST)
    expect(backupKindFor(new Date("2026-07-04T00:00:00Z"))).toBe("daily");
  });
});
