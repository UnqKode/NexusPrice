// UTC-anchored date helpers shared by the historical-prices route and the
// backfill worker. Price documents are stored at exact UTC midnight, one
// per day - every computation here that decides "which day is this" has to
// be anchored to UTC, not the process's local timezone, or it silently
// disagrees with the data depending on which timezone the process happens
// to run in. See dateRange.test.ts (behavior) and
// dateRange.adversarial-tz.test.ts (the class of bug this guards against,
// run explicitly under TZ=America/Los_Angeles - see vitest.adversarial-tz.config.ts).

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Adds (or subtracts, for a negative n) whole UTC days to a date. Always
 * lands on the same UTC time-of-day as the input, unconditionally - safe to
 * call repeatedly in a loop to walk day-by-day regardless of the process's
 * local timezone or DST transitions in that timezone, unlike
 * setDate(getDate() + 1) which is local-time and can drift by an hour
 * across a DST transition.
 */
export function addUtcDays(date: Date, n: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

export interface HistoricalRange {
  start: Date;
  increment: number;
}

/**
 * Computes the [start, now] window and bucket increment for a
 * /api/historical-prices timeRange value. UTC-anchored throughout -
 * getUTCDate/setUTCMonth/getUTCFullYear/etc, never the local-time
 * equivalents, so the computed boundaries don't depend on the server
 * process's timezone or daylight saving.
 */
export function computeHistoricalRange(timeRange: string, now: Date): HistoricalRange {
  const start = new Date(now);

  switch (timeRange) {
    case "1w":
      start.setUTCDate(now.getUTCDate() - 7);
      return { start, increment: DAY_MS };
    case "1m":
      start.setUTCMonth(now.getUTCMonth() - 1);
      return { start, increment: 5 * DAY_MS };
    case "3m":
      start.setUTCMonth(now.getUTCMonth() - 3);
      return { start, increment: 10 * DAY_MS };
    case "6m":
      start.setUTCMonth(now.getUTCMonth() - 6);
      return { start, increment: 30 * DAY_MS };
    case "1y":
      start.setUTCFullYear(now.getUTCFullYear() - 1);
      return { start, increment: 30 * DAY_MS };
    case "3y":
      start.setUTCFullYear(now.getUTCFullYear() - 3);
      return { start, increment: 30 * DAY_MS };
    default:
      start.setUTCDate(now.getUTCDate() - 7);
      return { start, increment: DAY_MS };
  }
}
