import { describe, it, expect } from "vitest";
import { addUtcDays, computeHistoricalRange } from "./dateRange";

describe("addUtcDays", () => {
  it("adds a whole UTC day", () => {
    const result = addUtcDays(new Date("2024-06-15T00:00:00.000Z"), 1);
    expect(result.toISOString()).toBe("2024-06-16T00:00:00.000Z");
  });

  it("subtracts for a negative n", () => {
    const result = addUtcDays(new Date("2024-06-15T00:00:00.000Z"), -1);
    expect(result.toISOString()).toBe("2024-06-14T00:00:00.000Z");
  });

  it("rolls over a UTC month/year boundary", () => {
    const result = addUtcDays(new Date("2023-12-31T00:00:00.000Z"), 1);
    expect(result.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("does not mutate the input date", () => {
    const input = new Date("2024-06-15T00:00:00.000Z");
    addUtcDays(input, 5);
    expect(input.toISOString()).toBe("2024-06-15T00:00:00.000Z");
  });
});

describe("computeHistoricalRange", () => {
  const now = new Date("2024-06-15T12:00:00.000Z");

  it("1w: 7 days before now, 1-day increment", () => {
    const { start, increment } = computeHistoricalRange("1w", now);
    expect(start.toISOString()).toBe("2024-06-08T12:00:00.000Z");
    expect(increment).toBe(24 * 60 * 60 * 1000);
  });

  it("1m: 1 UTC calendar month before now, 5-day increment", () => {
    const { start, increment } = computeHistoricalRange("1m", now);
    expect(start.toISOString()).toBe("2024-05-15T12:00:00.000Z");
    expect(increment).toBe(5 * 24 * 60 * 60 * 1000);
  });

  it("1y: 1 UTC calendar year before now, 30-day increment", () => {
    const { start, increment } = computeHistoricalRange("1y", now);
    expect(start.toISOString()).toBe("2023-06-15T12:00:00.000Z");
    expect(increment).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to the 1w window for an unrecognised timeRange", () => {
    const { start, increment } = computeHistoricalRange("nonsense", now);
    expect(start.toISOString()).toBe("2024-06-08T12:00:00.000Z");
    expect(increment).toBe(24 * 60 * 60 * 1000);
  });
});
