import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Same FakeRedis pattern as src/app/api/price/route.test.ts - kept local
// rather than extracted to a shared test util, to match how that file
// already does it (not touching that as part of this change).
class FakeRedis {
  private store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
}

const fakeRedis = new FakeRedis();
vi.mock("@/lib/redisConnect", () => ({ default: fakeRedis }));

const dbConnectMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/dbConnect", () => ({ default: (...args: unknown[]) => dbConnectMock(...args) }));

// Price.find(...).lean() - the single whole-range query added in Task 1c.
const priceFindMock = vi.fn();
vi.mock("@/model/price.model", () => ({
  default: { find: (...args: unknown[]) => ({ lean: () => priceFindMock(...args) }) },
}));

// getSeriesSummary wraps Price.aggregate(...) - mocked at this module
// boundary (like dbConnect/redisConnect above) rather than trying to stub
// Mongoose's aggregate() directly. The real pipeline is proven correct
// separately, against live Mongo, in priceAggregations.test.ts.
const getSeriesSummaryMock = vi.fn();
vi.mock("@/lib/priceAggregations", () => ({
  getSeriesSummary: (...args: unknown[]) => getSeriesSummaryMock(...args),
}));

// Auth/rate-limiting is tested separately in routeGuard.test.ts and the
// "authentication and rate limiting" block below - mocked here so the rest
// of this file stays focused on the Mongo/cache/pipeline behavior it was
// written to cover.
const guardRouteMock = vi.fn();
vi.mock("@/lib/routeGuard", () => ({ guardRoute: (...args: unknown[]) => guardRouteMock(...args) }));

const { POST } = await import("./route");

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/historical-prices", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

// Frozen at an exact UTC midnight so the "1w" bucketing in route.ts (7 daily
// buckets from now-7d up to, but excluding, now) is fully deterministic:
// 2024-01-01 .. 2024-01-07.
const FROZEN_NOW = new Date("2024-01-08T00:00:00.000Z");

describe("POST /api/historical-prices - Mongo read path (Task 1c)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    process.env.ALCHEMY_API_KEY = "test-key";
    dbConnectMock.mockReset().mockResolvedValue(undefined);
    priceFindMock.mockReset().mockResolvedValue([]);
    getSeriesSummaryMock.mockReset().mockResolvedValue({ percentChange: 0, volatility: 0, min: 0, max: 0 });
    guardRouteMock.mockReset().mockResolvedValue({
      ok: true,
      identity: { id: "test-key", scope: "read", via: "api-key" },
      headers: {},
    });
    // @ts-expect-error - resetting the private store between tests
    fakeRedis.store = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("truncates the Mongo query's lower bound to UTC midnight even when 'now' isn't midnight-aligned", async () => {
    // FROZEN_NOW is deliberately exact midnight, which sidesteps a real bug:
    // the query's $gte bound used to carry the current time-of-day, which
    // would exclude that same day's midnight-stored document. Freezing to a
    // non-midnight time here is what actually exercises that path.
    vi.setSystemTime(new Date("2024-01-08T14:23:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ value: "1.00" }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));

    const [filter] = priceFindMock.mock.calls[0];
    const gte: Date = filter.date.$gte;
    expect(gte.getUTCHours()).toBe(0);
    expect(gte.getUTCMinutes()).toBe(0);
    expect(gte.getUTCSeconds()).toBe(0);
    expect(gte.getUTCMilliseconds()).toBe(0);
  });

  it("issues exactly one Mongo query for the whole range, not one per bucket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ value: "1.00" }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));

    expect(priceFindMock).toHaveBeenCalledTimes(1);
  });

  it("resolves every bucket from Mongo, calls Alchemy zero times, and uses the aggregation pipeline for the summary", async () => {
    const days = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-06", "2024-01-07"];
    priceFindMock.mockResolvedValue(
      days.map((d, i) => ({ date: new Date(`${d}T00:00:00.000Z`), price: 100 + i }))
    );
    getSeriesSummaryMock.mockResolvedValue({ percentChange: 6, volatility: 1.23, min: 100, max: 106 });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));
    const body = await res.json();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.data).toHaveLength(7);
    expect(body.data.every((point: { method?: string }) => point.method === "db")).toBe(true);

    // Task 2 acceptance criterion: fully-Mongo-covered ranges use the pipeline.
    expect(getSeriesSummaryMock).toHaveBeenCalledTimes(1);
    expect(body.summary.source).toBe("pipeline");
    expect(body.summary).toMatchObject({ percentChange: 6, volatility: 1.23, min: 100, max: 106 });
  });

  it("uses the JS analytics path (not the pipeline) when any bucket came from cache or Alchemy", async () => {
    priceFindMock.mockResolvedValue([]); // nothing in Mongo - every bucket falls through to Alchemy
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ value: "100" }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));
    const body = await res.json();

    expect(getSeriesSummaryMock).not.toHaveBeenCalled();
    expect(body.summary.source).toBe("js");
    // Regression guard: summarize()'s return value has an extra `sma` field
    // at runtime that the pipeline path's shape doesn't have - it must not
    // leak into `summary` (the per-point sma on each data entry is enough).
    expect(body.summary).toEqual({
      percentChange: expect.any(Number),
      volatility: expect.any(Number),
      min: expect.any(Number),
      max: expect.any(Number),
      source: "js",
    });
  });

  it("falls back to the JS path if the pipeline itself throws, instead of failing the request", async () => {
    const days = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-06", "2024-01-07"];
    priceFindMock.mockResolvedValue(
      days.map((d, i) => ({ date: new Date(`${d}T00:00:00.000Z`), price: 100 + i }))
    );
    getSeriesSummaryMock.mockRejectedValue(new Error("aggregation exploded"));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary.source).toBe("js");
  });

  it("falls back to Alchemy for buckets missing from both Redis and Mongo, and tags them accordingly", async () => {
    priceFindMock.mockResolvedValue([]); // nothing in Mongo
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ value: "42" }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledTimes(7); // one per uncovered bucket
    expect(body.data.every((point: { method?: string }) => point.method === "alchemy")).toBe(true);

    // Task 8b: every Alchemy call must carry an abort signal.
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("prefers Redis over Mongo when both have the bucket", async () => {
    await fakeRedis.set(
      `price:0x0000000000000000000000000000000000000abc:ethereum:2024-01-01T00:00:00.000Z`,
      JSON.stringify({ historyPrice: "999" })
    );
    priceFindMock.mockResolvedValue([{ date: new Date("2024-01-01T00:00:00.000Z"), price: 1 }]);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));
    const body = await res.json();

    const jan1 = body.data.find((p: { date: string }) => p.date === "Jan 1");
    expect(jan1.method).toBe("cache");
    expect(jan1.price).toBe("999");
  });

  it("degrades to the Redis/Alchemy-only path instead of failing the request when Mongo is unreachable", async () => {
    priceFindMock.mockRejectedValue(new Error("Mongo unreachable"));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ value: "1.00" }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest({ tokenAddress: "0x0000000000000000000000000000000000000ABC", network: "ethereum", timeRange: "1w" }));
    const body = await res.json();

    // This endpoint worked without Mongo before Task 1c; a Mongo outage
    // should not turn a previously-working request into a 500.
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.every((point: { method?: string }) => point.method === "alchemy")).toBe(true);
  });
});
