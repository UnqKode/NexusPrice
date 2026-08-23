import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { RedisLike } from "../lib/priceCache";

// Minimal fake implementing just the rate limiter's eval-based
// compare-and-schedule semantics - see alchemyRateLimiter.test.ts for the
// primitive's own tests. A 1ms interval keeps these tests fast; the
// pacing behavior itself is tested in isolation there, not re-verified here.
class FakeRedis implements Pick<RedisLike, "eval"> {
  private nextAllowed = new Map<string, number>();
  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
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
const fakeRedis = new FakeRedis() as unknown as RedisLike;
const TEST_INTERVAL_MS = 1;

const dbConnectMock = vi.fn();
vi.mock("../lib/dbConnect", () => ({
  default: (...args: unknown[]) => dbConnectMock(...args),
}));

// Price.find(...).lean() is the one-round-trip existence check for the whole
// range; Price.updateOne(...) is the per-day upsert. Both are mocked
// separately so tests can assert on the actual Mongo calls this module makes.
const priceFindMock = vi.fn();
const priceUpdateOneMock = vi.fn();
vi.mock("../model/price.model", () => ({
  default: {
    find: (...args: unknown[]) => ({ lean: () => priceFindMock(...args) }),
    updateOne: (...args: unknown[]) => priceUpdateOneMock(...args),
  },
}));

// Imported after the mocks above so the module under test picks them up.
const { processor, fetchPriceRange, AlchemyRateLimitError } = await import("./priceProcessor");

function makeJob(data: { coinId: string; network: string }): Job {
  return { data, updateProgress: vi.fn().mockResolvedValue(undefined) } as unknown as Job;
}

interface MockResponseSpec {
  ok?: boolean;
  status?: number;
  jsonBody?: unknown;
  responseHeaders?: Record<string, string>;
}

function mockFetchSequence(responses: MockResponseSpec[]) {
  const impl = vi.fn();
  for (const r of responses) {
    const headerMap = new Map(Object.entries(r.responseHeaders ?? {}));
    impl.mockImplementationOnce(async () => ({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.jsonBody,
      text: async () => JSON.stringify(r.jsonBody),
      headers: { get: (key: string) => headerMap.get(key) ?? null },
    }));
  }
  global.fetch = impl as unknown as typeof fetch;
  return impl;
}

describe("fetchPriceRange", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses multiple daily points from a single range call", async () => {
    mockFetchSequence([
      {
        jsonBody: {
          data: [
            { value: "100.5", timestamp: "2024-01-01T00:00:00Z" },
            { value: "101.2", timestamp: "2024-01-02T00:00:00Z" },
          ],
        },
      },
    ]);

    const points = await fetchPriceRange("0xabc", "ethereum", new Date("2024-01-01"), new Date("2024-01-02"), fakeRedis, TEST_INTERVAL_MS);

    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ date: new Date("2024-01-01T00:00:00.000Z"), price: 100.5 });
    expect(points[1]).toEqual({ date: new Date("2024-01-02T00:00:00.000Z"), price: 101.2 });
  });

  it("throws AlchemyRateLimitError on 429, with Retry-After parsed when present", async () => {
    mockFetchSequence([{ ok: false, status: 429, jsonBody: { error: "rate limited" }, responseHeaders: { "Retry-After": "30" } }]);

    await expect(
      fetchPriceRange("0xabc", "ethereum", new Date("2024-01-01"), new Date("2024-01-02"), fakeRedis, TEST_INTERVAL_MS)
    ).rejects.toThrow(AlchemyRateLimitError);

    mockFetchSequence([{ ok: false, status: 429, jsonBody: { error: "rate limited" }, responseHeaders: { "Retry-After": "30" } }]);
    try {
      await fetchPriceRange("0xabc", "ethereum", new Date("2024-01-01"), new Date("2024-01-02"), fakeRedis, TEST_INTERVAL_MS);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AlchemyRateLimitError);
      expect((err as InstanceType<typeof AlchemyRateLimitError>).retryAfterMs).toBe(30_000);
    }
  });

  it("sets retryAfterMs to null when Retry-After is absent", async () => {
    mockFetchSequence([{ ok: false, status: 429, jsonBody: { error: "rate limited" } }]);

    try {
      await fetchPriceRange("0xabc", "ethereum", new Date("2024-01-01"), new Date("2024-01-02"), fakeRedis, TEST_INTERVAL_MS);
      expect.unreachable();
    } catch (err) {
      expect((err as InstanceType<typeof AlchemyRateLimitError>).retryAfterMs).toBeNull();
    }
  });

  it("returns an empty array (not a throw) for a non-429 error response", async () => {
    mockFetchSequence([{ ok: false, status: 500, jsonBody: { error: "boom" } }]);

    const points = await fetchPriceRange("0xabc", "ethereum", new Date("2024-01-01"), new Date("2024-01-02"), fakeRedis, TEST_INTERVAL_MS);
    expect(points).toEqual([]);
  });
});

describe("priceProcessor.processor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dbConnectMock.mockReset().mockResolvedValue(undefined);
    priceFindMock.mockReset().mockResolvedValue([]);
    priceUpdateOneMock.mockReset().mockResolvedValue({ upsertedCount: 1 });
  });

  it("skips the Alchemy call entirely when the whole (single-day) window is already known", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const fetchMock = mockFetchSequence([
      // findTokenBirthday only - birthday is "today" so there's exactly one window, one day
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: todayIso } }] } } },
    ]);
    priceFindMock.mockResolvedValue([{ date: today }]);

    const result = await processor(makeJob({ coinId: "0xAbC", network: "Ethereum" }), fakeRedis, TEST_INTERVAL_MS);

    expect(result.status).toBe("Completed");
    expect(priceFindMock).toHaveBeenCalledTimes(1); // one query for the whole range, not one per window
    expect(fetchMock).toHaveBeenCalledTimes(1); // birthday lookup only - no price-range call
    expect(priceUpdateOneMock).not.toHaveBeenCalled();
  });

  it("fetches a range and upserts each new day, using lowercased keys", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();
    const yesterday = new Date(today.getTime() - 86_400_000);

    const fetchMock = mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: yesterday.toISOString() } }] } } },
      {
        jsonBody: {
          data: [
            { value: "123.45", timestamp: yesterday.toISOString() },
            { value: "124.00", timestamp: todayIso },
          ],
        },
      },
    ]);

    const result = await processor(makeJob({ coinId: "0xAbC", network: "Ethereum" }), fakeRedis, TEST_INTERVAL_MS);

    expect(result.status).toBe("Completed");
    expect(priceUpdateOneMock).toHaveBeenCalledTimes(2);
    const [filter, update, options] = priceUpdateOneMock.mock.calls[0];
    expect(filter).toMatchObject({ tokenAddress: "0xabc", network: "ethereum" });
    expect(update.$setOnInsert).toMatchObject({ tokenAddress: "0xabc", network: "ethereum", price: 123.45 });
    expect(options).toEqual({ upsert: true });

    // Task 8b: every Alchemy call must carry an abort signal.
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("splits a multi-year range into multiple <=365-day windows, one Alchemy call each", async () => {
    // Birthday ~800 days ago -> 3 windows (365 + 365 + remainder).
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const birthday = new Date(today.getTime() - 800 * 86_400_000);

    const fetchMock = mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: birthday.toISOString() } }] } } },
      { jsonBody: { data: [] } }, // window 1
      { jsonBody: { data: [] } }, // window 2
      { jsonBody: { data: [] } }, // window 3
    ]);

    const job = makeJob({ coinId: "0xAbC", network: "Ethereum" });
    const result = await processor(job, fakeRedis, TEST_INTERVAL_MS);

    expect(result.status).toBe("Completed");
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 birthday lookup + 3 window calls
    expect(job.updateProgress).toHaveBeenCalledTimes(3); // once per window, not once per day
    const progressCalls = (job.updateProgress as ReturnType<typeof vi.fn>).mock.calls;
    const lastProgressCall = progressCalls[progressCalls.length - 1][0];
    expect(lastProgressCall).toMatchObject({ windowsProcessed: 3, totalWindows: 3, percent: 100 });
  });

  it("actually paces sequential window calls through the wired-up rate limiter, not just accepts the parameters", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const birthday = new Date(today.getTime() - 800 * 86_400_000); // 3 windows

    mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: birthday.toISOString() } }] } } },
      { jsonBody: { data: [] } },
      { jsonBody: { data: [] } },
      { jsonBody: { data: [] } },
    ]);

    const pacedIntervalMs = 150;
    const callTimestamps: number[] = [];
    const originalEval = fakeRedis.eval.bind(fakeRedis);
    fakeRedis.eval = async (...args) => {
      callTimestamps.push(Date.now());
      return originalEval(...args);
    };

    try {
      const start = Date.now();
      await processor(makeJob({ coinId: "0xAbC", network: "Ethereum" }), fakeRedis, pacedIntervalMs);
      const elapsed = Date.now() - start;

      // 3 window calls, each waiting its turn ~pacedIntervalMs apart -
      // proves fetchPriceRange is actually calling waitForRateLimitSlot
      // with the interval processor() was given, not silently ignoring it.
      expect(callTimestamps.length).toBe(3);
      expect(elapsed).toBeGreaterThanOrEqual(pacedIntervalMs * 2 - 40);
    } finally {
      fakeRedis.eval = originalEval;
    }
  });

  it("propagates a 429 (AlchemyRateLimitError) as a job failure instead of silently recording a gap", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: todayIso } }] } } },
      { ok: false, status: 429, jsonBody: { error: "rate limited" }, responseHeaders: { "Retry-After": "5" } },
    ]);

    await expect(processor(makeJob({ coinId: "0xabc", network: "ethereum" }), fakeRedis, TEST_INTERVAL_MS)).rejects.toThrow(AlchemyRateLimitError);
    expect(priceUpdateOneMock).not.toHaveBeenCalled();
  });

  it("does not write a record when a non-429 upstream error leaves a window with no data", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: todayIso } }] } } },
      { ok: false, status: 500, jsonBody: { error: "boom" } },
    ]);

    const result = await processor(makeJob({ coinId: "0xabc", network: "ethereum" }), fakeRedis, TEST_INTERVAL_MS);

    expect(result.status).toBe("Completed"); // the job still completes - a missing window is silently skipped
    expect(priceUpdateOneMock).not.toHaveBeenCalled();
  });

  it("treats a duplicate-key error (E11000) on the upsert as success, not a job failure", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();
    const yesterday = new Date(today.getTime() - 86_400_000);

    mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: yesterday.toISOString() } }] } } },
      { jsonBody: { data: [{ value: "123.45", timestamp: yesterday.toISOString() }] } },
    ]);
    const duplicateKeyError = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    priceUpdateOneMock.mockRejectedValue(duplicateKeyError);

    const result = await processor(makeJob({ coinId: "0xabc", network: "ethereum" }), fakeRedis, TEST_INTERVAL_MS);

    expect(result.status).toBe("Completed");
  });

  it("still fails the job on a non-duplicate-key Mongo error during the upsert", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();
    const yesterday = new Date(today.getTime() - 86_400_000);

    mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: yesterday.toISOString() } }] } } },
      { jsonBody: { data: [{ value: "123.45", timestamp: yesterday.toISOString() }] } },
    ]);
    priceUpdateOneMock.mockRejectedValue(new Error("Mongo connection reset"));

    await expect(processor(makeJob({ coinId: "0xabc", network: "ethereum" }), fakeRedis, TEST_INTERVAL_MS)).rejects.toThrow(
      "Mongo connection reset"
    );
  });

  it("throws (fails the job) when the upstream birthday lookup fails", async () => {
    mockFetchSequence([{ ok: false, status: 500, jsonBody: { error: "boom" } }]);

    await expect(processor(makeJob({ coinId: "0xabc", network: "ethereum" }), fakeRedis, TEST_INTERVAL_MS)).rejects.toThrow();

    // Retries for this failure are handled at the queue level (attempts +
    // backoff on queue.add in schedule/route.ts), not inside this function -
    // processor() itself makes no retry attempt.
    expect(priceUpdateOneMock).not.toHaveBeenCalled();
  });

  it("propagates a DB connection failure as a thrown error, not a process exit", async () => {
    dbConnectMock.mockRejectedValue(new Error("Mongo unreachable"));

    await expect(processor(makeJob({ coinId: "0xabc", network: "ethereum" }), fakeRedis, TEST_INTERVAL_MS)).rejects.toThrow("Mongo unreachable");

    // Regression guard for the dbConnect.ts fix: a DB hiccup must fail this
    // job, not call process.exit and take the whole process down with it.
  });
});
