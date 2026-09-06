// unique job id for a price history job, based on the coinId and network

export function historyJobId(coinId: string, network: string): string {
  return `history:${coinId.toLowerCase()}:${network.toLowerCase()}`;
}
