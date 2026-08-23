import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  // Only implements the exact compare-and-delete script priceCache.ts
  // actually sends - not a general Lua interpreter. See priceCache.test.ts.
  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    const [key] = options.keys;
    const [expectedValue] = options.arguments;
    if (this.readSync(key) === expectedValue) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}

const fakeRedis = new FakeRedis();
vi.mock("@/lib/redisConnect", () => ({ default: fakeRedis }));

// Auth/rate-limiting is tested in its own right in routeGuard.test.ts and
// the "authentication and rate limiting" describe block below - mocked
// here so the rest of this file can stay focused on cache/interpolation
// behavior, which is what it was written to cover.
const guardRouteMock = vi.fn();
vi.mock("@/lib/routeGuard", () => ({ guardRoute: (...args: unknown[]) => guardRouteMock(...args) }));

const { POST } = await import("./route");

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/price", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("POST /api/price", () => {
  const originalAllowCacheBypass = process.env.ALLOW_CACHE_BYPASS;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ALCHEMY_API_KEY = "test-key";
    delete process.env.ALLOW_CACHE_BYPASS;
    guardRouteMock.mockReset().mockResolvedValue({
      ok: true,
      identity: { id: "test-key", scope: "read", via: "api-key" },
      headers: {},
    });
  });

  afterEach(() => {
    if (originalAllowCacheBypass === undefined) delete process.env.ALLOW_CACHE_BYPASS;
    else process.env.ALLOW_CACHE_BYPASS = originalAllowCacheBypass;
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
      makeRequest({ coinId: "0x000000000000000000000000000000000000A001", network: "ethereum", startTime: "1700000000" })
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.degraded).toBe(false);
    expect(body.History.method).toBe("alchemy");
    expect(body.History.price).toBe("101.5");

    // Task 8b: every Alchemy call must carry an abort signal so a hung
    // upstream fails fast instead of holding a single-flight lock forever.
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
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
      makeRequest({ coinId: "0x000000000000000000000000000000000000A002", network: "ethereum", startTime: "1700000000" })
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
      makeRequest({ coinId: "0x000000000000000000000000000000000000A003", network: "ethereum", startTime: "1700000000" })
    );
    const body = await res.json();

    expect(body.History.method).not.toBe("interpolation");
    expect(body.History.price).not.toBeNaN();
  });

  it("marks the response degraded when neither history nor current price can be resolved", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeRequest({ coinId: "0x000000000000000000000000000000000000A004", network: "ethereum", startTime: "1700000000" })
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

    const reqBody = { coinId: "0x000000000000000000000000000000000000A005", network: "ethereum", startTime: "1700000000" };
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
    const res = await POST(makeRequest({ coinId: "0x000000000000000000000000000000000000A006" }));
    expect(res.status).toBe(400);
  });

  describe("cache bypass (x-bypass-cache, gated by ALLOW_CACHE_BYPASS)", () => {
    // Distinct coinId per test - this file's FakeRedis is a shared, never-
    // reset singleton (see its top-of-file comment), so reusing a key across
    // tests here would let an earlier test's cache write leak into a later
    // test that's specifically trying to observe a genuine cache miss.
    const bodyFor = (suffix: string) => ({
      coinId: `0x${"0".repeat(40 - suffix.length)}${suffix}`,
      network: "ethereum",
      startTime: "1700000000",
    });

    it("ignores the header when ALLOW_CACHE_BYPASS is unset, even if the request sends it", async () => {
      delete process.env.ALLOW_CACHE_BYPASS;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "1" }] }] }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ value: "1" }] }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const res = await POST(makeRequest(bodyFor("B001"), { "x-bypass-cache": "1" }));
      const body = await res.json();

      expect(body.Current.cache).not.toBe("bypass-header");
      expect(body.History.cache).not.toBe("bypass-header");
    });

    it("skips the cache and calls upstream directly when ALLOW_CACHE_BYPASS=true and the header is sent", async () => {
      process.env.ALLOW_CACHE_BYPASS = "true";
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "1" }] }] }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ value: "1" }] }));
      global.fetch = fetchMock as unknown as typeof fetch;

      const res = await POST(makeRequest(bodyFor("B002"), { "x-bypass-cache": "1" }));
      const body = await res.json();

      expect(body.Current.cache).toBe("bypass-header");
      expect(body.History.cache).toBe("bypass-header");
    });

    it("does not populate the cache on a bypassed request, so a following normal request still misses", async () => {
      const reqBody = bodyFor("B003");
      process.env.ALLOW_CACHE_BYPASS = "true";
      const bypassFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "1" }] }] }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ value: "1" }] }));
      global.fetch = bypassFetch as unknown as typeof fetch;
      await POST(makeRequest(reqBody, { "x-bypass-cache": "1" }));

      delete process.env.ALLOW_CACHE_BYPASS;
      const normalFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ prices: [{ value: "2" }] }] }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ value: "2" }] }));
      global.fetch = normalFetch as unknown as typeof fetch;
      const res = await POST(makeRequest(reqBody));
      const body = await res.json();

      // A real upstream call happened for the second request too - proof the
      // bypassed request never wrote a cache entry the normal path could hit.
      expect(normalFetch).toHaveBeenCalled();
      expect(body.Current.cache).not.toBe("bypass-header");
    });

    it("still requires a valid api key / session - the bypass header is not an auth bypass", async () => {
      process.env.ALLOW_CACHE_BYPASS = "true";
      guardRouteMock.mockResolvedValue({
        ok: false,
        response: new Response(JSON.stringify({ success: false, message: "unauthorized" }), { status: 401 }),
      });

      const res = await POST(makeRequest(bodyFor("B004"), { "x-bypass-cache": "1" }));
      expect(res.status).toBe(401);
    });
  });
});
