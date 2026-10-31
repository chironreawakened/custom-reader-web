/**
 * Backup kind selection.
 *
 * The nightly backup cron is `0 3 * * *` in Europe/Helsinki. Helsinki 03:00
 * is 01:00 UTC (EET) / 00:00 UTC (EEST) — the SAME UTC calendar day — so the
 * weekday must be derived in Europe/Helsinki; at this hour `getUTCDay()`
 * happens to agree, but only as long as the cron hour stays at/above the
 * UTC offset. Verified 2026-10-31 with Intl.DateTimeFormat.
 */
const HelsinkiWeekday = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Helsinki",
  weekday: "short",
});

/** 0 = Sunday … 6 = Saturday, as experienced in Europe/Helsinki. */
export function helsinkiWeekday(date: Date = new Date()): number {
  const short = HelsinkiWeekday.format(date);
  // Deterministic mapping; do not rely on Date parsing tricks (locale/DST).
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dow = map[short];
  if (dow === undefined) throw new Error(`unexpected weekday format: ${short}`);
  return dow;
}

/** Monday's run is the weekly backup; everything else is daily. */
export function backupKindFor(date: Date = new Date()): "daily" | "weekly" {
  return helsinkiWeekday(date) === 1 ? "weekly" : "daily";
}
