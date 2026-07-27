import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// route.ts imports the real Redis client from "@/lib/redisConnect", which
// opens a live connection as an import-time side effect. Mocking the module
// (rather than refactoring redisConnect.ts) is the pragmatic seam for an
// integration test that still exercises the real cache/interpolation logic.
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  // Synchronous check-and-write, matching real Redis's atomic SET NX -
  // see priceCache.test.ts for why this matters for single-flight tests.
  private readSync(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async get(key: string) {
    return this.readSync(key);
  }
  async set(key: string, value: string, opts?: { EX?: number; NX?: boolean; PX?: number }) {
    if (opts?.NX && this.readSync(key) !== null) return null;
    let expiresAt: number | null = null;
    if (opts?.EX) expiresAt = Date.now() + opts.EX * 1000;
    if (opts?.PX) expiresAt = Date.now() + opts.PX;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
}

const fakeRedis = new FakeRedis();
vi.mock("@/lib/redisConnect", () => ({ default: fakeRedis }));

const { POST } = await import("./route");

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/price", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("POST /api/price", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ALCHEMY_API_KEY = "test-key";
  });

  it("returns the exact Alchemy price when history data is available (no interpolation needed)", async () => {
    // Route fetches current price first, then history - see route.ts.
    const fetchMock = vi
      .fn()
      // currentPrice
      .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "102.0" }] }] }))
      // fetchHistoricalPrice
      .mockResolvedValueOnce(jsonResponse({ data: [{ value: "101.5" }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeRequest({ coinId: "0xToken1", network: "ethereum", startTime: "1700000000" })
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.degraded).toBe(false);
    expect(body.History.method).toBe("alchemy");
    expect(body.History.price).toBe("101.5");
  });

  it("falls back to interpolation when the exact historical price is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "105" }] }] })) // currentPrice
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // fetchHistoricalPrice: no exact match
      .mockResolvedValueOnce(jsonResponse({ data: [{ value: "100" }] })) // before
      .mockResolvedValueOnce(jsonResponse({ data: [{ value: "110" }] })); // after
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeRequest({ coinId: "0xToken2", network: "ethereum", startTime: "1700000000" })
    );
    const body = await res.json();

    expect(body.History.method).toBe("interpolation");
    expect(body.degraded).toBe(false);
  });

  it("does not mislabel a failed interpolation (missing before/after data) as a successful one", async () => {
    // Regression test: querying a time before the token has any price
    // history (before/after both come back empty) used to silently produce
    // NaN -> null while still reporting method:"interpolation" and
    // degraded:false. It must now be reported as degraded instead.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "50" }] }] })) // currentPrice
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // fetchHistoricalPrice: no exact match
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // before: no data
      .mockResolvedValueOnce(jsonResponse({ data: [] })); // after: no data
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeRequest({ coinId: "0xTokenTooOld", network: "ethereum", startTime: "1700000000" })
    );
    const body = await res.json();

    expect(body.History.method).not.toBe("interpolation");
    expect(body.History.price).not.toBeNaN();
  });

  it("marks the response degraded when neither history nor current price can be resolved", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeRequest({ coinId: "0xToken3", network: "ethereum", startTime: "1700000000" })
    );
    const body = await res.json();

    // This is the case that used to silently ship as a normal-looking 200.
    expect(res.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.History.method).toBe("none");
  });

  it("serves the second identical request from cache without calling Alchemy again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "78" }] }] })) // currentPrice
      .mockResolvedValueOnce(jsonResponse({ data: [{ value: "77" }] })); // fetchHistoricalPrice
    global.fetch = fetchMock as unknown as typeof fetch;

    const reqBody = { coinId: "0xToken4", network: "ethereum", startTime: "1700000000" };
    const first = await POST(makeRequest(reqBody));
    await first.json();

    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await POST(makeRequest(reqBody));
    const secondBody = await second.json();

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no new upstream calls
    expect(secondBody.History.cache).toBe("fresh");
    expect(secondBody.Current.cache).toBe("fresh");
  });

  it("rejects a request missing required fields with 400, not a silent failure", async () => {
    const res = await POST(makeRequest({ coinId: "0xToken5" }));
    expect(res.status).toBe(400);
  });
});
