import { describe, it, expect } from "vitest";
import { ALCHEMY_NETWORK_MAP, toAlchemyNetwork } from "./networks";

describe("toAlchemyNetwork", () => {
  it("maps every supported network, including the ones priceProcessor.ts used to be missing", () => {
    expect(toAlchemyNetwork("ethereum")).toBe("eth-mainnet");
    expect(toAlchemyNetwork("polygon")).toBe("polygon-mainnet");
    expect(toAlchemyNetwork("arbitrum")).toBe("arb-mainnet");
    expect(toAlchemyNetwork("optimism")).toBe("opt-mainnet");
    expect(toAlchemyNetwork("base")).toBe("base-mainnet");
    expect(toAlchemyNetwork("bsc")).toBe("bsc-mainnet");
    expect(toAlchemyNetwork("avalanche")).toBe("avax-mainnet");
  });

  it("is case-insensitive", () => {
    expect(toAlchemyNetwork("Ethereum")).toBe("eth-mainnet");
    expect(toAlchemyNetwork("BSC")).toBe("bsc-mainnet");
  });

  it("passes through an unrecognised network unchanged rather than silently dropping it", () => {
    expect(toAlchemyNetwork("some-future-chain")).toBe("some-future-chain");
  });

  it("covers exactly the seven networks the two API routes previously hardcoded", () => {
    expect(Object.keys(ALCHEMY_NETWORK_MAP).sort()).toEqual(
      ["arbitrum", "avalanche", "base", "bsc", "ethereum", "optimism", "polygon"].sort()
    );
  });
});
