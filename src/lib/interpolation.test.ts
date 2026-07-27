import { describe, it, expect } from "vitest";
import { interPolatePrice } from "./interpolation";

describe("interPolatePrice", () => {
  it("interpolates linearly at the midpoint", () => {
    const result = interPolatePrice("1500", "1000", "2000", "10", "20");
    expect(result).toBeCloseTo(15, 5);
  });

  it("returns the exact before price when current === before", () => {
    const result = interPolatePrice("1000", "1000", "2000", "10", "20");
    expect(result).toBeCloseTo(10, 5);
  });

  it("returns the exact after price when current === after", () => {
    const result = interPolatePrice("2000", "1000", "2000", "10", "20");
    expect(result).toBeCloseTo(20, 5);
  });

  it("clamps to the before price when current is earlier than the before bound", () => {
    // A caller passing an out-of-range timestamp should not extrapolate
    // beyond the known data points.
    const result = interPolatePrice("500", "1000", "2000", "10", "20");
    expect(result).toBeCloseTo(10, 5);
  });

  it("clamps to the after price when current is later than the after bound", () => {
    const result = interPolatePrice("2500", "1000", "2000", "10", "20");
    expect(result).toBeCloseTo(20, 5);
  });

  it("handles a falling price (after < before) correctly", () => {
    const result = interPolatePrice("1500", "1000", "2000", "20", "10");
    expect(result).toBeCloseTo(15, 5);
  });

  it("returns beforePrice without dividing by zero when before === after", () => {
    const result = interPolatePrice("1000", "1000", "1000", "10", "99999");
    expect(result).toBeCloseTo(10, 5);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("handles zero prices", () => {
    const result = interPolatePrice("1500", "1000", "2000", "0", "0");
    expect(result).toBe(0);
  });

  it("handles very small (sub-cent) token prices without losing precision", () => {
    const result = interPolatePrice("1500", "1000", "2000", "0.0000001234", "0.0000005678");
    expect(result).toBeCloseTo(0.0000003456, 9);
  });

  it("is NaN, not a crash, when given non-numeric price strings", () => {
    const result = interPolatePrice("1500", "1000", "2000", "not-a-number", "20");
    expect(Number.isNaN(result)).toBe(true);
  });

  it("produces a stable result regardless of timestamp string formatting", () => {
    const a = interPolatePrice("1500", "1000", "2000", "10", "20");
    const b = interPolatePrice("1500.0", "1000", "2000", "10", "20");
    expect(a).toBeCloseTo(b, 5);
  });
});
