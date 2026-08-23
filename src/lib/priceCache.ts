// Single-flight cache with stale-while-revalidate and jittered TTLs.
//
// Why this exists: a naive get/set cache either (a) lets every concurrent
// miss on a hot key hit the upstream API at once (stampede), or (b) blocks
// every request behind a single fetch with no way to serve slightly-stale
// data while a refresh is in flight. This combines four techniques so a
// hot key never causes more than one upstream call at a time, and Redis
// itself never becomes a hard dependency:
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
//   4. Fail-open on Redis - every Redis call is timeout-bounded and any
//      failure in the cache path (timeout, connection error, corrupt data)
//      degrades to calling upstream directly (source: "bypass") instead of
//      failing the request. A cache should make things faster, not be a
//      dependency that can take the service down when it's unavailable.

import { randomUUID } from "node:crypto";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean; PX?: number }
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
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
  /** Max time to wait on any single Redis call before treating the cache
   * path as failed and bypassing straight to fetchFresh(). node-redis has no
   * per-command timeout of its own (only a connection timeout, which
   * doesn't help once a connection exists but the host stops responding),
   * so without this a hung/unreachable Redis host hangs the request
   * indefinitely instead of degrading. */
  redisTimeoutMs?: number;
}

type ResolvedOptions = Required<SingleFlightOptions>;

const DEFAULTS: Omit<ResolvedOptions, "softTtlMs" | "hardTtlMs"> = {
  lockTtlMs: 10_000,
  lockWaitMs: 3_000,
  lockPollIntervalMs: 100,
  jitterRatio: 0.1,
  redisTimeoutMs: 2_000,
};

export type CacheSource = "fresh" | "stale" | "revalidated" | "bypass";

// Distinguishes "Redis itself failed" from "fetchFresh() (the upstream call)
// failed" - getWithSingleFlight's outer catch only bypasses on this type, so
// a genuine upstream failure during the normal cache flow still propagates
// to the caller once, rather than being swallowed and silently retried.
class RedisCacheError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RedisCacheError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredTtlSeconds(hardTtlMs: number, jitterRatio: number): number {
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round((hardTtlMs * jitter) / 1000));
}

function withRedisTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisCacheError(`Redis ${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof RedisCacheError ? err : new RedisCacheError(`Redis ${label} failed: ${err instanceof Error ? err.message : String(err)}`, err));
      }
    );
  });
}

// A corrupt/truncated envelope is treated as a miss rather than letting
// JSON.parse throw all the way out - and the bad key is deleted so it
// doesn't keep failing on every subsequent read.
async function parseEnvelope<T>(
  redis: RedisLike,
  key: string,
  raw: string,
  timeoutMs: number
): Promise<CacheEnvelope<T> | null> {
  try {
    return JSON.parse(raw) as CacheEnvelope<T>;
  } catch (err) {
    console.error(`⚠️ Corrupt cache envelope for key "${key}", treating as a miss:`, err);
    await withRedisTimeout(redis.del(key), timeoutMs, "DEL").catch(() => {});
    return null;
  }
}

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

// Compare-and-delete via Lua so releasing a lock is atomic: a holder whose
// lock already expired (e.g. a slow fetchFresh() that outran lockTtlMs) can
// no longer delete a *different*, newer holder's lock just because it
// shares the same key - it only deletes if the value still matches the
// random token it was given when it originally acquired the lock.
async function releaseLock(redis: RedisLike, lockKey: string, token: string, timeoutMs: number): Promise<void> {
  try {
    await withRedisTimeout(
      redis.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [token] }),
      timeoutMs,
      "EVAL"
    );
  } catch (err) {
    console.error(`⚠️ Failed to release lock "${lockKey}":`, err);
  }
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
  await withRedisTimeout(redis.set(key, JSON.stringify(envelope), { EX: ttlSeconds }), opts.redisTimeoutMs, "SET");
}

async function tryRevalidateInBackground<T>(
  redis: RedisLike,
  key: string,
  lockKey: string,
  fetchFresh: () => Promise<T>,
  opts: ResolvedOptions
): Promise<void> {
  const token = randomUUID();
  const acquired = await withRedisTimeout(
    redis.set(lockKey, token, { NX: true, PX: opts.lockTtlMs }),
    opts.redisTimeoutMs,
    "SET"
  ).catch(() => null);
  if (!acquired) return; // another process is already revalidating this key, or Redis failed

  try {
    const data = await fetchFresh();
    await writeCache(redis, key, data, opts).catch((err) => {
      console.error(`⚠️ Failed to write cache for key "${key}" after a successful background refresh:`, err);
    });
  } catch (err) {
    console.error(`⚠️ Background revalidation failed for key "${key}":`, err);
  } finally {
    await releaseLock(redis, lockKey, token, opts.redisTimeoutMs);
  }
}

async function runCacheFlow<T>(
  redis: RedisLike,
  key: string,
  lockKey: string,
  fetchFresh: () => Promise<T>,
  opts: ResolvedOptions
): Promise<{ data: T; source: CacheSource }> {
  const raw = await withRedisTimeout(redis.get(key), opts.redisTimeoutMs, "GET");

  if (raw) {
    const envelope = await parseEnvelope<T>(redis, key, raw, opts.redisTimeoutMs);

    if (envelope) {
      const age = Date.now() - envelope.storedAt;

      if (age < envelope.softTtlMs) {
        return { data: envelope.data, source: "fresh" };
      }

      // Soft-expired but still within hardTtl: serve stale immediately, and
      // let at most one caller refresh it in the background.
      void tryRevalidateInBackground(redis, key, lockKey, fetchFresh, opts);
      return { data: envelope.data, source: "stale" };
    }
    // Envelope was corrupt and has been deleted by parseEnvelope - fall
    // through to the hard-miss path below as if this had been a plain miss.
  }

  // Hard miss: try to become the single writer for this key.
  const token = randomUUID();
  const acquired = await withRedisTimeout(
    redis.set(lockKey, token, { NX: true, PX: opts.lockTtlMs }),
    opts.redisTimeoutMs,
    "SET"
  );

  if (acquired) {
    try {
      const data = await fetchFresh();
      // A write failure here shouldn't turn a successful upstream fetch
      // into a second, redundant one - just serve what we already have.
      await writeCache(redis, key, data, opts).catch((err) => {
        console.error(`⚠️ Failed to write cache for key "${key}" after a successful fetch:`, err);
      });
      return { data, source: "revalidated" };
    } finally {
      await releaseLock(redis, lockKey, token, opts.redisTimeoutMs);
    }
  }

  // Someone else is already fetching this key. Wait briefly rather than
  // stampeding upstream ourselves.
  const deadline = Date.now() + opts.lockWaitMs;
  while (Date.now() < deadline) {
    await sleep(opts.lockPollIntervalMs);
    const winnerRaw = await withRedisTimeout(redis.get(key), opts.redisTimeoutMs, "GET");
    if (winnerRaw) {
      const envelope = await parseEnvelope<T>(redis, key, winnerRaw, opts.redisTimeoutMs);
      if (envelope) {
        return { data: envelope.data, source: "revalidated" };
      }
      break; // corrupt - stop waiting, fall through to the bypass below
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

/**
 * Get-or-fetch with single-flight de-duplication and stale-while-revalidate.
 * `source` in the result tells you which path was taken, useful for metrics
 * (e.g. counting "bypass" tells you how often the lock-holder didn't finish
 * in time, or Redis itself was unavailable, which is a signal upstream
 * latency, lockTtlMs, or Redis health needs attention).
 */
export async function getWithSingleFlight<T>(
  redis: RedisLike,
  key: string,
  fetchFresh: () => Promise<T>,
  options: SingleFlightOptions
): Promise<{ data: T; source: CacheSource }> {
  const opts: ResolvedOptions = { ...DEFAULTS, ...options };
  const lockKey = `lock:${key}`;

  try {
    return await runCacheFlow(redis, key, lockKey, fetchFresh, opts);
  } catch (err) {
    if (!(err instanceof RedisCacheError)) {
      // A genuine upstream failure during the normal flow (e.g. the
      // lock-holder's own fetchFresh() threw) - not ours to swallow or
      // retry, the caller already handles this the same way it always has.
      throw err;
    }
    console.error(`⚠️ Cache path failed for key "${key}", bypassing to upstream:`, err);
    const data = await fetchFresh();
    return { data, source: "bypass" };
  }
}
