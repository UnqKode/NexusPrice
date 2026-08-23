import { describe, it, expect } from "vitest";
import { rateToIntervalMs, waitForRateLimitSlot } from "./alchemyRateLimiter";
import type { RedisLike } from "./priceCache";

describe("rateToIntervalMs", () => {
  it("encodes the real 300/hour ceiling as 1 request per 12 seconds, not a rounded max", () => {
    // This is the exact scenario that motivated this function: 300/3600 is
    // sub-1 req/s, and a naive {max: Math.round(rps), duration: 1000}
    // encoding would collapse to {max: 0, ...} or {max: 1, duration: 1000}
    // (12x too fast), not the correct once-per-12s pacing.
    expect(rateToIntervalMs(300 / 3600)).toBe(12000);
  });

  it("encodes 1 req/s as a 1000ms interval", () => {
    expect(rateToIntervalMs(1)).toBe(1000);
  });

  it("encodes 5 req/s as a 200ms interval", () => {
    expect(rateToIntervalMs(5)).toBe(200);
  });

  it("rejects a non-positive rate rather than dividing by zero or returning a negative interval", () => {
    expect(() => rateToIntervalMs(0)).toThrow();
    expect(() => rateToIntervalMs(-1)).toThrow();
  });
});

describe("waitForRateLimitSlot", () => {
  // Minimal fake implementing just the compare-and-schedule semantics the
  // real Lua script provides - enough to test the pacer's own logic
  // without a live Redis.
  class FakeRedis implements Pick<RedisLike, "eval"> {
    private nextAllowed = new Map<string, number>();
    failing = false;

    async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
      if (this.failing) throw new Error("simulated Redis outage");
      const [key] = options.keys;
      const [nowStr, intervalStr] = options.arguments;
      const now = Number(nowStr);
      const interval = Number(intervalStr);
      const prevNextAllowed = this.nextAllowed.get(key) ?? 0;
      const scheduled = prevNextAllowed > now ? prevNextAllowed : now;
      this.nextAllowed.set(key, scheduled + interval);
      return String(scheduled);
    }
  }

  it("does not delay the first caller for a key", async () => {
    const redis = new FakeRedis();
    const start = Date.now();
    await waitForRateLimitSlot(redis as unknown as RedisLike, "k", 1000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("schedules concurrent callers on the same key strictly intervalMs apart", async () => {
    const redis = new FakeRedis();
    const intervalMs = 150;
    const arrivalOrder: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map(() =>
        waitForRateLimitSlot(redis as unknown as RedisLike, "hot-key", intervalMs).then(() => {
          arrivalOrder.push(Date.now());
        })
      )
    );

    arrivalOrder.sort((a, b) => a - b);
    for (let i = 1; i < arrivalOrder.length; i++) {
      const gap = arrivalOrder[i] - arrivalOrder[i - 1];
      // Real timer scheduling isn't exact, especially under a full parallel
      // test-suite run - allow generous slack below the target interval,
      // but it must never be *far* short of it (i.e. not paced at all).
      expect(gap).toBeGreaterThanOrEqual(intervalMs - 40);
    }
  });

  it("does not pace two different keys against each other", async () => {
    const redis = new FakeRedis();
    const start = Date.now();
    await Promise.all([
      waitForRateLimitSlot(redis as unknown as RedisLike, "key-a", 5000),
      waitForRateLimitSlot(redis as unknown as RedisLike, "key-b", 5000),
    ]);
    // Both are first-callers on distinct keys - neither should wait out
    // the other's 5s interval.
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("fails open (does not throw or hang) when Redis is unavailable", async () => {
    const redis = new FakeRedis();
    redis.failing = true;

    await expect(waitForRateLimitSlot(redis as unknown as RedisLike, "k", 1000)).resolves.toBeUndefined();
  });

  it("stays collision-free when two simulated worker processes have skewed clocks", async () => {
    // WORKER_CONCURRENCY>1, or running multiple `npm run worker` instances,
    // means this pacer routinely has to arbitrate between callers from
    // different processes that don't share a clock - and the earlier live
    // test against real Redis showed execution order on the server doesn't
    // always match client-side invocation order once network latency
    // varies per call. This simulates both at once: "process B" reaches
    // this shared key second (an artificial delay inside eval stands in
    // for its slower round trip to Redis), but its own clock reads
    // *behind* "process A"'s - exactly the combination that would let a
    // naive implementation double-book a slot or let a lagging clock jump
    // the queue.
    class DelayableFakeRedis implements Pick<RedisLike, "eval"> {
      private nextAllowed = new Map<string, number>();
      private callIndex = 0;
      constructor(private readonly delaysByCallIndex: number[]) {}

      async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
        const myIndex = this.callIndex++;
        const delay = this.delaysByCallIndex[myIndex] ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

        const [key] = options.keys;
        const [nowStr, intervalStr] = options.arguments;
        const now = Number(nowStr);
        const interval = Number(intervalStr);
        const prevNextAllowed = this.nextAllowed.get(key) ?? 0;
        const scheduled = prevNextAllowed > now ? prevNextAllowed : now;
        this.nextAllowed.set(key, scheduled + interval);
        return String(scheduled);
      }
    }

    // Process A: no delay, reaches Redis first. Process B: delayed 40ms
    // (reaches Redis second, after A has already reserved a slot), but its
    // clock reads 80ms *behind* A's - a combined clock-skew + latency-skew
    // scenario.
    const redis = new DelayableFakeRedis([0, 40]);
    const scheduledValues: number[] = [];
    const originalEval = redis.eval.bind(redis);
    redis.eval = async (...args) => {
      const result = await originalEval(...args);
      scheduledValues.push(Number(result));
      return result;
    };

    const baseNow = Date.now();
    const intervalMs = 100;
    await Promise.all([
      waitForRateLimitSlot(redis as unknown as RedisLike, "hot-key", intervalMs, baseNow), // process A
      waitForRateLimitSlot(redis as unknown as RedisLike, "hot-key", intervalMs, baseNow - 80), // process B, clock behind
    ]);

    expect(scheduledValues).toHaveLength(2);
    const [scheduledA, scheduledB] = scheduledValues;

    // The safety property that has to hold regardless of clock skew: no
    // two callers ever get the same slot, and the caller that actually
    // executes second is never scheduled *before* the slot already
    // reserved by the first - even though process B's own clock would, if
    // trusted blindly, suggest it arrived earlier than process A.
    expect(scheduledA).not.toBe(scheduledB);
    expect(scheduledB).toBeGreaterThanOrEqual(scheduledA);
    expect(scheduledB - scheduledA).toBeGreaterThanOrEqual(intervalMs);
  });
});
