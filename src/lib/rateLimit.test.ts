import { describe, it, expect } from "vitest";
import { checkRateLimit, rateLimitHeaders } from "./rateLimit";
import type { RateLimitRedis } from "./rateLimit";

class FakeRedis implements RateLimitRedis {
  private counts = new Map<string, number>();
  failing = false;

  async incr(key: string): Promise<number> {
    if (this.failing) throw new Error("simulated Redis outage");
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async expire(): Promise<unknown> {
    if (this.failing) throw new Error("simulated Redis outage");
    return 1;
  }
}

describe("checkRateLimit", () => {
  it("allows requests up to the limit and reports decreasing remaining", async () => {
    const redis = new FakeRedis();
    const r1 = await checkRateLimit(redis, "key-a", 3, 60);
    const r2 = await checkRateLimit(redis, "key-a", 3, 60);
    const r3 = await checkRateLimit(redis, "key-a", 3, 60);

    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect([r1.remaining, r2.remaining, r3.remaining]).toEqual([2, 1, 0]);
  });

  it("rejects requests once the limit is exceeded, with a positive retryAfterSeconds", async () => {
    const redis = new FakeRedis();
    for (let i = 0; i < 3; i++) await checkRateLimit(redis, "key-a", 3, 60);

    const result = await checkRateLimit(redis, "key-a", 3, 60);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks distinct identifiers independently", async () => {
    const redis = new FakeRedis();
    for (let i = 0; i < 3; i++) await checkRateLimit(redis, "key-a", 3, 60);

    const otherKeyResult = await checkRateLimit(redis, "key-b", 3, 60);
    expect(otherKeyResult.allowed).toBe(true);
  });

  it("fails open when Redis is unavailable and failClosed is not set", async () => {
    const redis = new FakeRedis();
    redis.failing = true;

    const result = await checkRateLimit(redis, "key-a", 3, 60);
    expect(result.allowed).toBe(true);
    expect(result.redisUnavailable).toBe(true);
  });

  it("fails closed when Redis is unavailable and failClosed is set", async () => {
    const redis = new FakeRedis();
    redis.failing = true;

    const result = await checkRateLimit(redis, "key-a", 3, 60, { failClosed: true });
    expect(result.allowed).toBe(false);
    expect(result.redisUnavailable).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not set redisUnavailable on a normal, successful check", async () => {
    const redis = new FakeRedis();
    const result = await checkRateLimit(redis, "key-a", 3, 60);
    expect(result.redisUnavailable).toBeUndefined();
  });
});

describe("rateLimitHeaders", () => {
  it("includes standard X-RateLimit-* headers but not Retry-After when allowed", () => {
    const headers = rateLimitHeaders({ allowed: true, limit: 10, remaining: 5, resetAt: Date.now() + 60_000 });
    expect(headers["X-RateLimit-Limit"]).toBe("10");
    expect(headers["X-RateLimit-Remaining"]).toBe("5");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("includes Retry-After when not allowed", () => {
    const headers = rateLimitHeaders({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      retryAfterSeconds: 30,
    });
    expect(headers["Retry-After"]).toBe("30");
  });
});
