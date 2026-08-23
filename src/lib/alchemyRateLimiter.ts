// Distributed, steady-rate pacing for calls that draw from Alchemy's
// token_price quota bucket (300 requests/hour on the free tier, confirmed
// via the actual "exceeded your limit" error text - see fetchPriceRange in
// priceProcessor.ts). Shared across every worker process via Redis: a
// per-process in-memory limiter wouldn't coordinate across multiple
// `npm run worker` instances, and BullMQ's own queue-wide limiter paces JOB
// dispatch, not the variable number of Alchemy calls one job can make
// internally (a job can issue anywhere from zero calls, if every window is
// already backfilled, up to ~9-11 for an old token) - sizing a dispatch
// limiter for that worst case would throttle every job as if it always
// needed the maximum, wasting most of the real budget on the common case.
// See priceWorker.ts for how this replaces the queue limiter entirely.
import type { RedisLike } from "./priceCache";

// Converts a target rate into the spacing between requests. A BullMQ-style
// {max, duration} limiter would encode this the same way for a sub-1 rate -
// {max: 1, duration: rateToIntervalMs(rps)} - rather than a fractional or
// rounded-up max, which is why this is exported as a standalone,
// independently testable piece of the encoding rather than buried inside
// the pacer below.
export function rateToIntervalMs(requestsPerSecond: number): number {
  if (!(requestsPerSecond > 0)) {
    throw new Error(`requestsPerSecond must be positive, got ${requestsPerSecond}`);
  }
  return Math.round(1000 / requestsPerSecond);
}

const RESERVE_SLOT_SCRIPT = `
local nextAllowed = tonumber(redis.call("GET", KEYS[1]) or "0")
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local scheduled = now
if nextAllowed > now then
  scheduled = nextAllowed
end
redis.call("SET", KEYS[1], scheduled + interval, "PX", ttlMs)
return tostring(scheduled)
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocks until this caller's turn under a steady, distributed rate limit.
 * Every call sharing `key` (across every process) is scheduled exactly
 * `intervalMs` apart via a single atomic Lua script (GET+SET in one round
 * trip), so concurrent callers from different worker processes get
 * distinct, monotonically increasing turns instead of racing - evenly
 * spread traffic rather than a burst followed by a wait.
 *
 * Fails open: if Redis itself is unreachable, this logs and returns
 * immediately rather than blocking the job - Redis is already a hard
 * dependency for BullMQ to receive jobs at all, so a pacer outage isn't a
 * new failure mode, and an occasional unpaced request risks a 429 (now
 * correctly retried, not silently recorded as a gap) rather than stalling
 * the whole worker.
 */
export async function waitForRateLimitSlot(
  redis: RedisLike,
  key: string,
  intervalMs: number,
  // Injectable purely for testing multi-process clock skew - real callers
  // never pass this and get the actual clock. Two worker processes (which
  // WORKER_CONCURRENCY>1 and running multiple `npm run worker` instances
  // both make routine) don't share a clock, and network latency to Redis
  // varies per call regardless - see the "skewed clocks" test for why the
  // script's max(now, nextAllowed) logic has to hold up even when a
  // caller's own timestamp doesn't match the order it actually executes in.
  now: number = Date.now()
): Promise<void> {
  try {
    // Comfortably outlives the wait itself so the reservation doesn't
    // expire mid-queue under heavy contention.
    const ttlMs = Math.max(intervalMs * 10, 60_000);
    const result = await redis.eval(RESERVE_SLOT_SCRIPT, {
      keys: [key],
      arguments: [String(now), String(intervalMs), String(ttlMs)],
    });
    const scheduled = Number(result);
    const waitMs = scheduled - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  } catch (err) {
    console.error(`⚠️ Rate limiter unavailable, proceeding unpaced for key "${key}":`, err);
  }
}
