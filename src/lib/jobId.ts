// Deterministic BullMQ job id for a token/network backfill. Using a
// deterministic id instead of letting BullMQ generate a random one means:
// (1) re-submitting "Schedule Full History" for the same token while a job
// is already pending/active is a no-op instead of queuing a duplicate,
// wasteful, multi-minute job, and (2) the status endpoint can look a job up
// by (coinId, network) without the client having to remember a random id.
export function historyJobId(coinId: string, network: string): string {
  return `history:${coinId.toLowerCase()}:${network.toLowerCase()}`;
}
