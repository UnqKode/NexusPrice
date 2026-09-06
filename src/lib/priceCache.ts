// a single file implementation of a single-flight cache with stale-while-revalidate semantics, using Redis as the backing store. 
//This is useful for caching expensive upstream calls (e.g., to a database or external API) while avoiding stampedes when many requests come in for the same key at once.

import { randomUUID } from "node:crypto"; // generate a random token for single-flight locks

export interface RedisLike {  // typesafety
  get(key: string): Promise<string | null>; // returns null if the key does not exist
  set( // returns "OK" if the operation was successful, or null if the key was not set due to NX option
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean; PX?: number }
  ): Promise<unknown>;
  del(key: string): Promise<unknown>; // returns the number of keys that were removed
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>; // returns the result of the script execution
}

interface CacheEnvelope<T> { // represents the structure of the cached data stored in Redis
  data: T;
  storedAt: number;
  softTtlMs: number;
}

export interface SingleFlightOptions {
  softTtlMs: number; // how long to serve stale data before revalidating
  hardTtlMs: number; // how long before the cache entry is considered expired and removed from Redis
  lockTtlMs?: number; // how long to hold the single-flight lock before it expires
  lockWaitMs?: number; // how long to wait for the lock-holder to finish before giving up and fetching upstream ourselves
  lockPollIntervalMs?: number; // how often to poll for the lock-holder's completion while waiting
  jitterRatio?: number; // the ratio of jitter to apply to the hard TTL when writing to Redis (e.g., 0.1 means +/-10% jitter)
  redisTimeoutMs?: number; // max time to wait on any single Redis call before treating the cache path as failed
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

class RedisCacheError extends Error { // differentiate Redis failures from upstream failures so we can degrade to bypassing the cache instead of throwing
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RedisCacheError";
  }
}

function sleep(ms: number): Promise<void> { // function to pause execution for a given number of milliseconds
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredTtlSeconds(hardTtlMs: number, jitterRatio: number): number { // apply jitter to the hard TTL to avoid stampedes when many keys expire at once
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round((hardTtlMs * jitter) / 1000));
}

function withRedisTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> { // wrap a Redis call in a timeout so that if it takes too long, we treat it as a failure and degrade to bypassing the cache instead of blocking the request indefinitely
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisCacheError(`Redis ${label} timed out after ${ms}ms`)), ms); // timeout to reject the promise if the Redis call takes too long
    promise.then(
      (value) => {
        clearTimeout(timer); // clear the timeout if the Redis call succeeds before the timeout
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof RedisCacheError ? err : new RedisCacheError(`Redis ${label} failed: ${err instanceof Error ? err.message : String(err)}`, err));
      }
    );
  });
}

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
`; // script to release a lock only if the token matches, preventing accidental deletion of another process's lock

async function releaseLock(redis: RedisLike, lockKey: string, token: string, timeoutMs: number): Promise<void> { // release the single-flight lock if we still hold it, using a Lua script to ensure atomicity
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

async function writeCache<T>( // write the cache envelope to Redis with a jittered TTL
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
    redis.set(lockKey, token, { NX: true, PX: opts.lockTtlMs }), // .set either writes a data or  creates a lock if the key does not exist, and returns null if the key already exists (i.e., another process is already revalidating this key)
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

async function runCacheFlow<T>( // the main cache flow: try to get from cache, if stale or missing, fetch fresh and write back to cache, with single-flight locking to prevent stampedes
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
      void tryRevalidateInBackground(redis, key, lockKey, fetchFresh, opts);
      return { data: envelope.data, source: "stale" };
    }
  }

  // Hard miss: try to become the single writer for this key.
  const token = randomUUID();
  const acquired = await withRedisTimeout( // put a lock in Redis to become the single-flight writer for this key, with a timeout to avoid blocking indefinitely if Redis is slow or unavailable
    redis.set(lockKey, token, { NX: true, PX: opts.lockTtlMs }),
    opts.redisTimeoutMs,
    "SET"
  );

  if (acquired) {
    try {
      const data = await fetchFresh();
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
export async function getWithSingleFlight<T>( // main entry point for the single-flight cache flow
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
      throw err;
    }
    console.error(`⚠️ Cache path failed for key "${key}", bypassing to upstream:`, err);
    const data = await fetchFresh();
    return { data, source: "bypass" };
  }
}
