//simple mapping of network names to Alchemy network names
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
