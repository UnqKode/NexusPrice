import { describe, it, expect, vi } from "vitest";
import { getWithSingleFlight, type RedisLike } from "./priceCache";

// Minimal in-memory stand-in for the real Redis client, supporting just
// enough of SET NX/PX/EX semantics for the single-flight/SWR logic under
// test. This is what makes priceCache.ts testable without a real Redis
// instance - the module takes its client as a parameter instead of
// importing the singleton directly.
class FakeRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  /** Test hook: when true, every method rejects, simulating a total Redis outage. */
  failing = false;

  // Synchronous on purpose: real Redis's SET NX is a single atomic command.
  // If this read a value via an `await`-ing method first, two concurrent
  // callers could both pass the "key doesn't exist" check before either
  // writes - a check-then-act race the real command doesn't have. Keeping
  // the check-and-write in one synchronous call is what makes this fake a
  // faithful enough stand-in for testing single-flight locking.
  private readSync(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  private failIfDown() {
    if (this.failing) throw new Error("ECONNREFUSED (simulated Redis outage)");
  }

  async get(key: string): Promise<string | null> {
    this.failIfDown();
    return this.readSync(key);
  }

  async set(
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean; PX?: number }
  ): Promise<unknown> {
    this.failIfDown();
    if (opts?.NX && this.readSync(key) !== null) return null;
    let expiresAt: number | null = null;
    if (opts?.EX) expiresAt = Date.now() + opts.EX * 1000;
    if (opts?.PX) expiresAt = Date.now() + opts.PX;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    this.failIfDown();
    return this.store.delete(key) ? 1 : 0;
  }

  // Only implements the exact compare-and-delete script priceCache.ts
  // actually sends - not a general Lua interpreter.
  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    this.failIfDown();
    const [key] = options.keys;
    const [expectedValue] = options.arguments;
    if (this.readSync(key) === expectedValue) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  expiresAtFor(key: string): number | null {
    return this.store.get(key)?.expiresAt ?? null;
  }

  /** Test-only: read the raw stored value without TTL/failure semantics. */
  rawPeek(key: string): string | null {
    return this.store.get(key)?.value ?? null;
  }

  /** Test-only: overwrite a key directly, simulating another process's write. */
  rawSet(key: string, value: string): void {
    this.store.set(key, { value, expiresAt: null });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("getWithSingleFlight", () => {
  it("calls fetchFresh on a hard miss and caches the result", async () => {
    const redis = new FakeRedis();
    const fetchFresh = vi.fn().mockResolvedValue("42");

    const result = await getWithSingleFlight(redis, "k1", fetchFresh, {
      softTtlMs: 1000,
      hardTtlMs: 5000,
    });

    expect(result).toEqual({ data: "42", source: "revalidated" });
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh cache hit without calling fetchFresh again", async () => {
    const redis = new FakeRedis();
    const fetchFresh = vi.fn().mockResolvedValue("42");
    const opts = { softTtlMs: 1000, hardTtlMs: 5000 };

    await getWithSingleFlight(redis, "k1", fetchFresh, opts);
    const second = await getWithSingleFlight(redis, "k1", fetchFresh, opts);

    expect(second).toEqual({ data: "42", source: "fresh" });
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("serves stale data immediately once past softTtl, and refreshes in the background", async () => {
    const redis = new FakeRedis();
    let call = 0;
    const fetchFresh = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1 ? "first" : "second";
    });
    const opts = { softTtlMs: 100, hardTtlMs: 5000 };

    const first = await getWithSingleFlight(redis, "k1", fetchFresh, opts);
    expect(first).toEqual({ data: "first", source: "revalidated" });

    await sleep(150); // comfortably pass softTtl

    const stale = await getWithSingleFlight(redis, "k1", fetchFresh, opts);
    expect(stale.source).toBe("stale");
    expect(stale.data).toBe("first"); // stale value returned instantly, not blocked on refresh

    await sleep(30); // let the background revalidation (no artificial delay) finish, well under softTtlMs

    const fresh = await getWithSingleFlight(redis, "k1", fetchFresh, opts);
    expect(fresh).toEqual({ data: "second", source: "fresh" });
    expect(fetchFresh).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent misses on the same key to a single upstream call (stampede protection)", async () => {
    const redis = new FakeRedis();
    let inFlight = 0;
    let maxConcurrent = 0;
    const fetchFresh = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await sleep(50);
      inFlight -= 1;
      return "value";
    });
    const opts = { softTtlMs: 1000, hardTtlMs: 5000, lockWaitMs: 500, lockPollIntervalMs: 10 };

    const [a, b, c] = await Promise.all([
      getWithSingleFlight(redis, "hot-key", fetchFresh, opts),
      getWithSingleFlight(redis, "hot-key", fetchFresh, opts),
      getWithSingleFlight(redis, "hot-key", fetchFresh, opts),
    ]);

    expect(fetchFresh).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
    expect([a.data, b.data, c.data]).toEqual(["value", "value", "value"]);
  });

  it("degrades to a direct fetch (bypass) if the lock-holder never finishes", async () => {
    const redis = new FakeRedis();
    // Simulate an abandoned lock (e.g. the holder crashed mid-fetch).
    await redis.set("lock:k1", "1", { NX: true, PX: 10_000 });

    const fetchFresh = vi.fn().mockResolvedValue("recovered");
    const opts = { softTtlMs: 1000, hardTtlMs: 5000, lockWaitMs: 60, lockPollIntervalMs: 10 };

    const result = await getWithSingleFlight(redis, "k1", fetchFresh, opts);

    expect(result).toEqual({ data: "recovered", source: "bypass" });
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("releases the lock even when fetchFresh throws, so the next request can retry", async () => {
    const redis = new FakeRedis();
    const failingFetch = vi.fn().mockRejectedValueOnce(new Error("upstream down"));
    const opts = { softTtlMs: 1000, hardTtlMs: 5000 };

    await expect(getWithSingleFlight(redis, "k1", failingFetch, opts)).rejects.toThrow(
      "upstream down"
    );
    expect(await redis.get("lock:k1")).toBeNull();

    const recoveringFetch = vi.fn().mockResolvedValue("ok");
    const result = await getWithSingleFlight(redis, "k1", recoveringFetch, opts);
    expect(result).toEqual({ data: "ok", source: "revalidated" });
  });

  it("applies jitter to the stored TTL within the configured ratio", async () => {
    const redis = new FakeRedis();
    const fetchFresh = vi.fn().mockResolvedValue("v");
    const hardTtlMs = 10_000;
    const jitterRatio = 0.2;

    const before = Date.now();
    await getWithSingleFlight(redis, "k1", fetchFresh, { softTtlMs: 1000, hardTtlMs, jitterRatio });
    const expiresAt = redis.expiresAtFor("k1");

    expect(expiresAt).not.toBeNull();
    const ttl = (expiresAt as number) - before;
    expect(ttl).toBeGreaterThanOrEqual(hardTtlMs * (1 - jitterRatio) - 50);
    expect(ttl).toBeLessThanOrEqual(hardTtlMs * (1 + jitterRatio) + 50);
  });

  // Task 8a: Redis must not be a hard dependency.
  describe("Redis failure handling (Task 8a)", () => {
    it("falls through to a direct upstream fetch when Redis is completely unavailable", async () => {
      const redis = new FakeRedis();
      redis.failing = true;
      const fetchFresh = vi.fn().mockResolvedValue("upstream-value");

      const result = await getWithSingleFlight(redis, "k1", fetchFresh, {
        softTtlMs: 1000,
        hardTtlMs: 5000,
      });

      expect(result).toEqual({ data: "upstream-value", source: "bypass" });
      expect(fetchFresh).toHaveBeenCalledTimes(1); // exactly once - not retried
    });

    it("still propagates a genuine upstream failure when Redis is healthy (does not double-call fetchFresh)", async () => {
      const redis = new FakeRedis();
      const failingFetch = vi.fn().mockRejectedValue(new Error("Alchemy down"));

      await expect(
        getWithSingleFlight(redis, "k1", failingFetch, { softTtlMs: 1000, hardTtlMs: 5000 })
      ).rejects.toThrow("Alchemy down");

      // A Redis-healthy, upstream-failing call is not a cache problem - it
      // must not be reinterpreted as "bypass" and retried a second time.
      expect(failingFetch).toHaveBeenCalledTimes(1);
    });

    it("times out a hung Redis call instead of hanging the request indefinitely", async () => {
      const redis = new FakeRedis();
      // Simulate a connected-but-unresponsive Redis: the promise never settles.
      redis.get = () => new Promise(() => {});
      const fetchFresh = vi.fn().mockResolvedValue("upstream-value");

      const result = await getWithSingleFlight(redis, "k1", fetchFresh, {
        softTtlMs: 1000,
        hardTtlMs: 5000,
        redisTimeoutMs: 50,
      });

      expect(result).toEqual({ data: "upstream-value", source: "bypass" });
    });
  });

  // Task 8b: a hung upstream fetch must not hold the single-flight lock for
  // its full duration - it should release as soon as fetchFresh rejects
  // (e.g. via AbortSignal.timeout in the real fetch call), not wait out lockTtlMs.
  describe("lock release on upstream failure (Task 8b)", () => {
    it("releases the lock promptly when fetchFresh rejects (e.g. an aborted/timed-out fetch), not after the full lockTtlMs", async () => {
      const redis = new FakeRedis();
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      const failingFetch = vi.fn().mockRejectedValueOnce(abortError);
      const opts = { softTtlMs: 1000, hardTtlMs: 5000, lockTtlMs: 60_000 }; // deliberately long

      await expect(getWithSingleFlight(redis, "k1", failingFetch, opts)).rejects.toThrow(
        "aborted"
      );

      // If the lock were only cleared by its PX expiry, this would still be
      // held (lockTtlMs is 60s). It must be gone immediately instead.
      expect(redis.rawPeek("lock:k1")).toBeNull();

      const recoveringFetch = vi.fn().mockResolvedValue("ok");
      const result = await getWithSingleFlight(redis, "k1", recoveringFetch, opts);
      expect(result.source).toBe("revalidated"); // proves the lock was actually free, not just unobserved
    });
  });

  // Task 8g: fencing token on the lock.
  describe("lock fencing (Task 8g)", () => {
    it("does not delete a newer holder's lock when a slow, expired holder releases with a stale token", async () => {
      const redis = new FakeRedis();

      const slowFetch = vi.fn().mockImplementation(async () => {
        // While "holding" the lock, simulate it having expired and a second
        // process winning a fresh acquisition with a different token -
        // exactly what a Lua-based compare-and-delete is meant to survive.
        redis.rawSet("lock:k1", "newer-holders-token");
        return "slow-value";
      });

      const result = await getWithSingleFlight(redis, "k1", slowFetch, {
        softTtlMs: 1000,
        hardTtlMs: 5000,
      });

      expect(result.data).toBe("slow-value");
      // The lock must still belong to the "newer" holder - the original
      // holder's release should have been a no-op, not a delete.
      expect(redis.rawPeek("lock:k1")).toBe("newer-holders-token");
    });
  });

  // Task 8h: guard JSON.parse of the cache envelope.
  describe("corrupt cache envelope handling (Task 8h)", () => {
    it("treats a corrupt envelope as a miss, deletes it, and does not throw", async () => {
      const redis = new FakeRedis();
      redis.rawSet("k1", "{not valid json");
      const fetchFresh = vi.fn().mockResolvedValue("fresh-value");

      const result = await getWithSingleFlight(redis, "k1", fetchFresh, {
        softTtlMs: 1000,
        hardTtlMs: 5000,
      });

      expect(result).toEqual({ data: "fresh-value", source: "revalidated" });
      expect(fetchFresh).toHaveBeenCalledTimes(1);

      // The corrupt value must have been replaced with a valid envelope,
      // not left in place to fail again on the next read.
      const stored = redis.rawPeek("k1");
      expect(() => JSON.parse(stored as string)).not.toThrow();
    });

    it("treats a corrupt envelope encountered while waiting for another holder as a reason to stop waiting, not throw", async () => {
      const redis = new FakeRedis();
      await redis.set("lock:k1", "someone-elses-token", { NX: true, PX: 10_000 });
      redis.rawSet("k1", "{also not valid json");

      const fetchFresh = vi.fn().mockResolvedValue("recovered-value");
      const opts = { softTtlMs: 1000, hardTtlMs: 5000, lockWaitMs: 200, lockPollIntervalMs: 10 };

      const result = await getWithSingleFlight(redis, "k1", fetchFresh, opts);

      expect(result).toEqual({ data: "recovered-value", source: "bypass" });
    });
  });
});
