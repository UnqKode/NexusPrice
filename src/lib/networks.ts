// Canonical mapping from this app's network identifiers to Alchemy's network
// slugs. Previously defined three times with inconsistent coverage - the two
// API routes covered seven networks, but priceProcessor.ts only covered
// four, so scheduling a backfill for a Base or BSC token silently passed an
// unmapped network string straight through to Alchemy instead of failing
// clearly. One list now, used everywhere a network needs to be translated.
export const ALCHEMY_NETWORK_MAP: Record<string, string> = {
  ethereum: "eth-mainnet",
  polygon: "polygon-mainnet",
  arbitrum: "arb-mainnet",
  optimism: "opt-mainnet",
  base: "base-mainnet",
  bsc: "bsc-mainnet",
  avalanche: "avax-mainnet",
};

export function toAlchemyNetwork(network: string): string {
  return ALCHEMY_NETWORK_MAP[network.toLowerCase()] || network;
}
