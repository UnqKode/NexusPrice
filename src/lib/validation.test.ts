import { describe, it, expect } from "vitest";
import { isValidTokenAddress } from "./validation";

describe("isValidTokenAddress", () => {
  it("accepts a well-formed 0x + 40 hex chars address", () => {
    expect(isValidTokenAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")).toBe(true);
  });

  it("accepts all-lowercase and all-uppercase hex", () => {
    expect(isValidTokenAddress("0x" + "a".repeat(40))).toBe(true);
    expect(isValidTokenAddress("0x" + "F".repeat(40))).toBe(true);
  });

  it("rejects a missing 0x prefix", () => {
    expect(isValidTokenAddress("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(isValidTokenAddress("0xC02aaA39")).toBe(false);
    expect(isValidTokenAddress("0x" + "a".repeat(41))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidTokenAddress("0x" + "g".repeat(40))).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(isValidTokenAddress(undefined)).toBe(false);
    expect(isValidTokenAddress(null)).toBe(false);
    expect(isValidTokenAddress(12345)).toBe(false);
    expect(isValidTokenAddress({})).toBe(false);
  });

  it("rejects an address with injected characters (e.g. attempting to break a Redis key)", () => {
    expect(isValidTokenAddress("0x" + "a".repeat(38) + ":*")).toBe(false);
  });
});
