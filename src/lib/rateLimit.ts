// Per-key fixed-window rate limiting using Redis INCR + EXPIRE - no new
// dependency, as intended. Fixed window (not sliding) is the simpler of
// the two the task allowed for, and INCR/EXPIRE is exactly what a fixed
// window needs: the first request in a window creates the counter and sets
// its expiry, every subsequent request in that window just increments it.

export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix ms when the current window ends and the count resets. */
  resetAt: number;
  /** Only set when `allowed` is false. */
  retryAfterSeconds?: number;
  /**
   * True when this result came from a Redis error, not a real count - i.e.
   * the caller can't distinguish "under the limit" from "couldn't check the
   * limit" without this flag. routeGuard.ts uses it to respond 503 instead
   * of 429 (the request wasn't rejected for exceeding a quota, it was
   * rejected/allowed because the limiter itself is unavailable).
   */
  redisUnavailable?: boolean;
}

export interface RateLimitOptions {
  /**
   * What to do when Redis itself errors. Default false (fail open) matches
   * the rest of this codebase's Redis-optionality stance (see priceCache.ts,
   * alchemyRateLimiter.ts). Set true for routes that spend Alchemy quota
   * directly (not via the queue): with fail-open, a Redis outage removes
   * rate limiting for exactly those routes, and priceCache's own
   * single-flight cache *also* fails open during the same outage (bypasses
   * to calling Alchemy directly) - so an outage doesn't just remove
   * throttling, it simultaneously removes the caching that would otherwise
   * absorb repeat requests, meaning every single request becomes a real,
   * unthrottled Alchemy call. The 300/hour free-tier quota can be burned
   * through by a modest concurrent load in seconds under that combination.
   * Fail-closed here trades a bounded, fast-recovering failure (503,
   * retry in ~10s) for that unbounded, slow-recovering one (quota
   * exhaustion that blocks every caller, including unrelated ones, for up
   * to an hour). Routes with nothing to protect (e.g. a read-only BullMQ
   * status lookup that never calls Alchemy) should leave this false - fail
   * closed only where the outage's alternative failure mode is worse than
   * a 503.
   */
  failClosed?: boolean;
}

// How long to ask a fail-closed caller to wait before retrying, when Redis
// itself is the thing that's down. Deliberately shorter than most routes'
// windowSeconds (this codebase's shortest is 60s, longest 3600s) - a Redis
// blip is usually much shorter than either, so telling the caller to wait
// out the full window would be needlessly pessimistic.
const REDIS_OUTAGE_RETRY_SECONDS = 10;

/**
 * Fails open (treats the request as allowed) by default if Redis itself
 * errors - see RateLimitOptions.failClosed for when and why to override
 * this per route.
 */
export async function checkRateLimit(
  redis: RateLimitRedis,
  identifier: string,
  limit: number,
  windowSeconds: number,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const windowBucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `ratelimit:${identifier}:${windowBucket}`;
  const resetAt = (windowBucket + 1) * windowSeconds * 1000;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // Only the request that created the counter needs to set its expiry.
      await redis.expire(key, windowSeconds);
    }

    const remaining = Math.max(0, limit - count);
    const allowed = count <= limit;

    return {
      allowed,
      limit,
      remaining,
      resetAt,
      retryAfterSeconds: allowed ? undefined : Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    };
  } catch (err) {
    if (options.failClosed) {
      console.error(`⚠️ Rate limiter unavailable, failing closed for "${identifier}":`, err);
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: Date.now() + REDIS_OUTAGE_RETRY_SECONDS * 1000,
        retryAfterSeconds: REDIS_OUTAGE_RETRY_SECONDS,
        redisUnavailable: true,
      };
    }
    console.error(`⚠️ Rate limiter unavailable, failing open for "${identifier}":`, err);
    return { allowed: true, limit, remaining: limit, resetAt, redisUnavailable: true };
  }
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)), // unix seconds
  };
  if (result.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }
  return headers;
}
