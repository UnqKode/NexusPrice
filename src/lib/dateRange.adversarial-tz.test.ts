// Run explicitly via `npm run test:tz-adversarial` (see
// vitest.adversarial-tz.config.ts, which pins TZ=America/Los_Angeles for
// this file only - a negative-offset, DST-observing timezone). Not part of
// the default `npm test` run.
//
// Every assertion here asserts the objectively correct UTC-anchored
// result, not "buggy vs fixed" - these are written to fail against
// dateRange.ts's pre-fix (local-time) implementation and pass once it's
// UTC-anchored. Each scenario below was verified empirically (via a plain
// Node script under TZ=America/Los_Angeles) before being written into a
// test, specifically because naive assumptions about which cases diverge
// turned out to be wrong on the first attempt - e.g. a plain 7-day
// subtraction with no DST transition in the window does NOT diverge
// between local and UTC computation, even under a negative offset; it only
// diverges when the window crosses an actual DST transition, or for the
// month/year branches near a calendar boundary.
import { describe, it, expect } from "vitest";
import { addUtcDays, computeHistoricalRange } from "./dateRange";

describe("computeHistoricalRange under TZ=America/Los_Angeles", () => {
  // 'now' is deliberately just after UTC midnight on March 1, 2024 (a leap
  // year - Feb has 29 days). In Los_Angeles (UTC-8, PST in effect - DST
  // doesn't start until March 10), this instant is Feb 29, 18:00 local:
  // local and UTC disagree about which *month* "now" falls in.
  const now = new Date("2024-03-01T02:00:00.000Z");

  it("1m: start is exactly one UTC calendar month before now, not one *local* calendar month", () => {
    const { start } = computeHistoricalRange("1m", now);
    expect(start.toISOString()).toBe("2024-02-01T02:00:00.000Z");
  });

  it("3m", () => {
    const { start } = computeHistoricalRange("3m", now);
    expect(start.toISOString()).toBe("2023-12-01T02:00:00.000Z");
  });

  it("6m", () => {
    const { start } = computeHistoricalRange("6m", now);
    expect(start.toISOString()).toBe("2023-09-01T02:00:00.000Z");
  });

  it("1y", () => {
    const { start } = computeHistoricalRange("1y", now);
    expect(start.toISOString()).toBe("2023-03-01T02:00:00.000Z");
  });

  it("3y", () => {
    const { start } = computeHistoricalRange("3y", now);
    expect(start.toISOString()).toBe("2021-03-01T02:00:00.000Z");
  });

  it("1w: the 7-day window crosses the actual DST transition (2024-03-10 in Los_Angeles)", () => {
    // now = 2024-03-12T01:00:00Z; 7 days earlier crosses March 10's
    // spring-forward, so the offset used at each end of the local-time
    // computation genuinely differs - this is the one case where "1w"
    // itself is vulnerable, not the plain negative-offset case.
    const nowNearDst = new Date("2024-03-12T01:00:00.000Z");
    const { start } = computeHistoricalRange("1w", nowNearDst);
    expect(start.toISOString()).toBe("2024-03-05T01:00:00.000Z");
  });
});

describe("addUtcDays under TZ=America/Los_Angeles", () => {
  it("adds exactly 24 hours across the DST spring-forward transition (2024-03-10)", () => {
    // Local-time setDate(getDate()+1) on this exact instant lands on
    // 2024-03-10T23:00:00.000Z instead (verified empirically) - the local
    // wall-clock offset changes from PST to PDT partway through the
    // conversion, losing an hour.
    const start = new Date("2024-03-10T00:00:00.000Z");
    const next = addUtcDays(start, 1);
    expect(next.toISOString()).toBe("2024-03-11T00:00:00.000Z");
  });

  it("adds exactly 24 hours across the DST fall-back transition (2024-11-03)", () => {
    const start = new Date("2024-11-03T00:00:00.000Z");
    const next = addUtcDays(start, 1);
    expect(next.toISOString()).toBe("2024-11-04T00:00:00.000Z");
  });

  it("walking a 10-day range one day at a time across spring-forward stays on exact UTC midnights throughout", () => {
    let current = new Date("2024-03-07T00:00:00.000Z");
    const end = new Date("2024-03-17T00:00:00.000Z");
    const days: string[] = [];
    while (current <= end) {
      days.push(current.toISOString());
      current = addUtcDays(current, 1);
    }
    // Every single entry must be exact UTC midnight - this is what the
    // worker's existingDateKeys / Mongo exact-match lookup depends on.
    for (const iso of days) {
      expect(iso.endsWith("T00:00:00.000Z")).toBe(true);
    }
    expect(days).toHaveLength(11);
  });
});
