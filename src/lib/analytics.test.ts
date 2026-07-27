import { describe, it, expect } from "vitest";
import { simpleMovingAverage, percentChange, volatility, summarize } from "./analytics";

describe("simpleMovingAverage", () => {
  it("is null until the window fills, then averages the trailing window", () => {
    const result = simpleMovingAverage([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  it("treats a window size of 1 as the series itself", () => {
    expect(simpleMovingAverage([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it("returns all nulls when the window is larger than the series", () => {
    expect(simpleMovingAverage([1, 2], 5)).toEqual([null, null]);
  });

  it("guards against a zero or negative window size", () => {
    expect(simpleMovingAverage([1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(simpleMovingAverage([1, 2, 3], -5)).toEqual([1, 2, 3]);
  });

  it("handles an empty series", () => {
    expect(simpleMovingAverage([], 3)).toEqual([]);
  });
});

describe("percentChange", () => {
  it("computes overall % change from first to last price", () => {
    expect(percentChange([100, 110, 120])).toBeCloseTo(20, 5);
  });

  it("handles a falling price", () => {
    expect(percentChange([100, 90])).toBeCloseTo(-10, 5);
  });

  it("returns 0 for a series with fewer than two points", () => {
    expect(percentChange([100])).toBe(0);
    expect(percentChange([])).toBe(0);
  });

  it("returns 0 rather than dividing by zero when the first price is 0", () => {
    expect(percentChange([0, 50])).toBe(0);
  });
});

describe("volatility", () => {
  it("is 0 for a perfectly flat price series", () => {
    expect(volatility([100, 100, 100, 100])).toBe(0);
  });

  it("is 0 when there are fewer than two returns to compare", () => {
    expect(volatility([100])).toBe(0);
    expect(volatility([100, 110])).toBe(0); // only one return
  });

  it("is positive for a series with varying returns", () => {
    const v = volatility([100, 110, 95, 120, 90]);
    expect(v).toBeGreaterThan(0);
    expect(Number.isFinite(v)).toBe(true);
  });

  it("skips a period where the previous price is 0 instead of producing Infinity/NaN", () => {
    const v = volatility([0, 100, 110, 105]);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe("summarize", () => {
  it("returns zeroed defaults for an empty series without throwing", () => {
    expect(summarize([])).toEqual({ percentChange: 0, volatility: 0, min: 0, max: 0, sma: [] });
  });

  it("bundles min/max/percentChange/volatility/sma consistently", () => {
    const result = summarize([100, 105, 95, 110], 2);
    expect(result.min).toBe(95);
    expect(result.max).toBe(110);
    expect(result.percentChange).toBeCloseTo(10, 5);
    expect(result.sma).toEqual([null, 102.5, 100, 102.5]);
  });
});
