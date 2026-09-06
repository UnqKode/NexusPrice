//we implement a Redis-backed fixed window rate limiter here, and use it in routeGuard.ts to protect routes
export interface RateLimitRedis {
  incr(key: string): Promise<number>; // increments the counter for the given key and returns the new value
  expire(key: string, seconds: number): Promise<unknown>; // sets the expiry for the given key to the given number of seconds
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
  redisUnavailable?: boolean;
}

export interface RateLimitOptions {
  failClosed?: boolean;  // If true, treat Redis errors as "over the limit" (fail closed) instead of "under the limit" (fail open). See checkRateLimit() for more details.
}

const REDIS_OUTAGE_RETRY_SECONDS = 10; // When failing closed due to a Redis outage, how long to tell the client to wait before retrying. This is a best-effort guess, since we don't know when Redis will be back up, but it's better than telling the client to retry immediately and have them hit the same outage again.


export async function checkRateLimit( // return {true , false} if the request is allowed or not, and some metadata about the rate limit
  redis: RateLimitRedis,
  identifier: string, 
  limit: number,
  windowSeconds: number, 
  options: RateLimitOptions = {} 
): Promise<RateLimitResult> {

  const windowBucket = Math.floor(Date.now() / 1000 / windowSeconds); // a bucket is create for a minute, hour, etc. depending on windowSeconds.
  const key = `ratelimit:${identifier}:${windowBucket}`; 
  const resetAt = (windowBucket + 1) * windowSeconds * 1000; // when to reset the counter for this window, in unix ms

  
  try {
    const count = await redis.incr(key); // returns the new value of the counter after incrementing it
    if (count === 1) { //newly created key, set the expiry for this window
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
