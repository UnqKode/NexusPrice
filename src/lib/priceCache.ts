// Single-flight cache with stale-while-revalidate and jittered TTLs.
//
// Why this exists: a naive get/set cache either (a) lets every concurrent
// miss on a hot key hit the upstream API at once (stampede), or (b) blocks
// every request behind a single fetch with no way to serve slightly-stale
// data while a refresh is in flight. This combines three techniques so a
// hot key never causes more than one upstream call at a time:
//
//   1. Single-flight lock (SET NX PX) - only one caller per key is allowed
//      to be "the one calling upstream" at any moment. Everyone else either
//      waits briefly for that caller to finish, or serves stale data.
//   2. Stale-while-revalidate - once a value passes its soft TTL it is still
//      served immediately (source: "stale") while a refresh is kicked off
//      in the background, so callers never pay the upstream latency on a
//      cache that is merely old rather than empty.
//   3. Jittered hard TTL - the eventual Redis expiry is randomized +/- a
//      ratio so that a batch of keys written around the same time (e.g. a
//      backfill run) don't all expire in the same second and reintroduce a
//      stampede at the "many keys expire together" level.

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean; PX?: number }
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

interface CacheEnvelope<T> {
  data: T;
  storedAt: number;
  softTtlMs: number;
}

export interface SingleFlightOptions {
  /** How long the value is considered fresh; no refetch triggered while inside this window. */
  softTtlMs: number;
  /** How long Redis retains the value at all (the stale-but-servable window ends here). */
  hardTtlMs: number;
  /** How long a single-flight lock is held before it's assumed abandoned. */
  lockTtlMs?: number;
  /** How long a waiter blocks for the lock-holder before giving up and fetching itself. */
  lockWaitMs?: number;
  lockPollIntervalMs?: number;
  /** +/- ratio applied to hardTtlMs, e.g. 0.1 = +/-10%, to desynchronize expiry. */
  jitterRatio?: number;
}

type ResolvedOptions = Required<SingleFlightOptions>;

const DEFAULTS: Omit<ResolvedOptions, "softTtlMs" | "hardTtlMs"> = {
  lockTtlMs: 10_000,
  lockWaitMs: 3_000,
  lockPollIntervalMs: 100,
  jitterRatio: 0.1,
};

export type CacheSource = "fresh" | "stale" | "revalidated" | "bypass";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredTtlSeconds(hardTtlMs: number, jitterRatio: number): number {
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round((hardTtlMs * jitter) / 1000));
}

async function writeCache<T>(
  redis: RedisLike,
  key: string,
  data: T,
  opts: ResolvedOptions
): Promise<void> {
  const envelope: CacheEnvelope<T> = {
    data,
    storedAt: Date.now(),
    softTtlMs: opts.softTtlMs,
  };
  const ttlSeconds = jitteredTtlSeconds(opts.hardTtlMs, opts.jitterRatio);
  await redis.set(key, JSON.stringify(envelope), { EX: ttlSeconds });
}

async function tryRevalidateInBackground<T>(
  redis: RedisLike,
  key: string,
  lockKey: string,
  fetchFresh: () => Promise<T>,
  opts: ResolvedOptions
): Promise<void> {
  const acquired = await redis.set(lockKey, "1", { NX: true, PX: opts.lockTtlMs });
  if (!acquired) return; // another process is already revalidating this key

  try {
    const data = await fetchFresh();
    await writeCache(redis, key, data, opts);
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

/**
 * Get-or-fetch with single-flight de-duplication and stale-while-revalidate.
 * `source` in the result tells you which path was taken, useful for metrics
 * (e.g. counting "bypass" tells you how often the lock-holder didn't finish
 * in time, which is a signal upstream latency or lockTtlMs needs attention).
 */
export async function getWithSingleFlight<T>(
  redis: RedisLike,
  key: string,
  fetchFresh: () => Promise<T>,
  options: SingleFlightOptions
): Promise<{ data: T; source: CacheSource }> {
  const opts: ResolvedOptions = { ...DEFAULTS, ...options };
  const lockKey = `lock:${key}`;

  const raw = await redis.get(key);
  if (raw) {
    const envelope: CacheEnvelope<T> = JSON.parse(raw);
    const age = Date.now() - envelope.storedAt;

    if (age < envelope.softTtlMs) {
      return { data: envelope.data, source: "fresh" };
    }

    // Soft-expired but still within hardTtl: serve stale immediately, and
    // let at most one caller refresh it in the background.
    void tryRevalidateInBackground(redis, key, lockKey, fetchFresh, opts);
    return { data: envelope.data, source: "stale" };
  }

  // Hard miss: try to become the single writer for this key.
  const acquired = await redis.set(lockKey, "1", { NX: true, PX: opts.lockTtlMs });

  if (acquired) {
    try {
      const data = await fetchFresh();
      await writeCache(redis, key, data, opts);
      return { data, source: "revalidated" };
    } finally {
      await redis.del(lockKey).catch(() => {});
    }
  }

  // Someone else is already fetching this key. Wait briefly rather than
  // stampeding upstream ourselves.
  const deadline = Date.now() + opts.lockWaitMs;
  while (Date.now() < deadline) {
    await sleep(opts.lockPollIntervalMs);
    const winnerRaw = await redis.get(key);
    if (winnerRaw) {
      const envelope: CacheEnvelope<T> = JSON.parse(winnerRaw);
      return { data: envelope.data, source: "revalidated" };
    }
  }

  // The lock-holder never finished in time (e.g. crashed mid-fetch while
  // holding the lock). Degrade to fetching ourselves rather than hanging
  // indefinitely - this is the one path that can still stampede, by design:
  // it trades a bounded amount of duplicate upstream load for never blocking
  // a request forever behind a dead lock-holder.
  const data = await fetchFresh();
  await writeCache(redis, key, data, opts).catch(() => {});
  return { data, source: "bypass" };
}
