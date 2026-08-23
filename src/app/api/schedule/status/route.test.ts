import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Same real-guardRoute approach as ../route.test.ts - this endpoint had no
// test coverage at all before Task 7.
vi.mock("next-auth", () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/authOptions", () => ({ authOptions: {} }));

const getJobMock = vi.fn();
vi.mock("@/lib/priceHistoryQueue", () => ({
  default: { getJob: (...args: unknown[]) => getJobMock(...args) },
}));

class FakeRedis {
  counts = new Map<string, number>();
  async incr(key: string) {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
  async expire() {
    return 1;
  }
}
const fakeRedis = new FakeRedis();
vi.mock("@/lib/redisConnect", () => ({ default: fakeRedis }));

const { resetApiKeyCacheForTests } = await import("@/lib/apiAuth");
const { GET } = await import("./route");

const VALID_ADDRESS = "0x000000000000000000000000000000000000A001";

function makeRequest(query: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/schedule/status${query}`, { headers });
}

describe("GET /api/schedule/status", () => {
  const originalApiKeys = process.env.API_KEYS;

  beforeEach(() => {
    resetApiKeyCacheForTests();
    process.env.API_KEYS = "reader-key,admin-key:admin";
    getJobMock.mockReset();
    fakeRedis.counts.clear();
  });

  afterEach(() => {
    process.env.API_KEYS = originalApiKeys;
    resetApiKeyCacheForTests();
  });

  it("rejects a request with no api key with 401", async () => {
    const res = await GET(makeRequest(`?coinId=${VALID_ADDRESS}&network=ethereum`));
    expect(res.status).toBe(401);
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it("does not require admin scope - a read-scoped key is enough to poll status", async () => {
    getJobMock.mockResolvedValue(null);
    const res = await GET(
      makeRequest(`?coinId=${VALID_ADDRESS}&network=ethereum`, { "x-api-key": "reader-key" })
    );
    expect(res.status).toBe(200);
  });

  it("returns found:false when no job exists for that coinId/network yet", async () => {
    getJobMock.mockResolvedValue(null);
    const res = await GET(
      makeRequest(`?coinId=${VALID_ADDRESS}&network=ethereum`, { "x-api-key": "reader-key" })
    );
    const body = await res.json();
    expect(body.found).toBe(false);
    expect(body.state).toBe("not_found");
  });

  it("returns the job's state and progress when a job is found", async () => {
    getJobMock.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("completed"),
      progress: 100,
      returnvalue: { ok: true },
      failedReason: null,
      attemptsMade: 1,
    });

    const res = await GET(
      makeRequest(`?coinId=${VALID_ADDRESS}&network=ethereum`, { "x-api-key": "reader-key" })
    );
    const body = await res.json();

    expect(body.found).toBe(true);
    expect(body.state).toBe("completed");
    expect(body.progress).toBe(100);
    expect(body.result).toEqual({ ok: true });
  });

  it("rejects a request missing query params with 400", async () => {
    const res = await GET(makeRequest("", { "x-api-key": "reader-key" }));
    expect(res.status).toBe(400);
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed coinId with 400", async () => {
    const res = await GET(
      makeRequest("?coinId=not-an-address&network=ethereum", { "x-api-key": "reader-key" })
    );
    expect(res.status).toBe(400);
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After once the per-key limit is exceeded", async () => {
    getJobMock.mockResolvedValue(null);
    // RATE_LIMIT in route.ts is { limit: 120, windowSeconds: 60 }.
    for (let i = 0; i < 120; i++) {
      const res = await GET(
        makeRequest(`?coinId=${VALID_ADDRESS}&network=ethereum`, { "x-api-key": "reader-key" })
      );
      expect(res.status).toBe(200);
    }

    const overLimit = await GET(
      makeRequest(`?coinId=${VALID_ADDRESS}&network=ethereum`, { "x-api-key": "reader-key" })
    );
    expect(overLimit.status).toBe(429);
    expect(overLimit.headers.get("Retry-After")).toBeTruthy();
  });
});
