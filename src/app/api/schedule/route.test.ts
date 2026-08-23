import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Unlike price/route.test.ts and historical-prices/route.test.ts (which mock
// guardRoute directly to stay focused on their own business logic), this
// file exercises the REAL guardRoute + apiAuth + rateLimit stack end to end,
// since /api/schedule and /api/schedule/status previously had zero test
// coverage and the whole point of Task 7 is proving the wiring itself works,
// not just that a mock resolves.
vi.mock("next-auth", () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/authOptions", () => ({ authOptions: {} }));

const dbConnectMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/dbConnect", () => ({ default: (...args: unknown[]) => dbConnectMock(...args) }));

const queueAddMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/priceHistoryQueue", () => ({
  default: { add: (...args: unknown[]) => queueAddMock(...args) },
}));

// Minimal fake satisfying RateLimitRedis (incr/expire) - the real fixed-
// window counter logic runs against it, not a mock of checkRateLimit itself.
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
const { POST } = await import("./route");

const VALID_ADDRESS = "0x000000000000000000000000000000000000A001";

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/schedule", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/schedule", () => {
  const originalApiKeys = process.env.API_KEYS;

  beforeEach(() => {
    resetApiKeyCacheForTests();
    process.env.API_KEYS = "reader-key,admin-key:admin";
    dbConnectMock.mockClear();
    queueAddMock.mockClear();
    fakeRedis.counts.clear();
  });

  afterEach(() => {
    process.env.API_KEYS = originalApiKeys;
    resetApiKeyCacheForTests();
  });

  it("rejects a request with no api key with 401, before touching Mongo or the queue", async () => {
    const res = await POST(makeRequest({ coinId: VALID_ADDRESS, network: "ethereum" }));
    expect(res.status).toBe(401);
    expect(dbConnectMock).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it("rejects a read-scoped key with 403, since scheduling a backfill is admin-only", async () => {
    const res = await POST(
      makeRequest({ coinId: VALID_ADDRESS, network: "ethereum" }, { "x-api-key": "reader-key" })
    );
    expect(res.status).toBe(403);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it("queues a job and returns 200 for a valid admin key", async () => {
    const res = await POST(
      makeRequest({ coinId: VALID_ADDRESS, network: "ethereum" }, { "x-api-key": "admin-key" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [, jobData, jobOpts] = queueAddMock.mock.calls[0];
    expect(jobData).toEqual({ coinId: VALID_ADDRESS, network: "ethereum" });
    expect(jobOpts.jobId).toBe(`history:${VALID_ADDRESS.toLowerCase()}:ethereum`);
  });

  it("rejects a malformed address with 400, without queuing a job", async () => {
    const res = await POST(
      makeRequest({ coinId: "not-an-address", network: "ethereum" }, { "x-api-key": "admin-key" })
    );
    expect(res.status).toBe(400);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it("rejects a request missing required fields with 400", async () => {
    const res = await POST(makeRequest({ coinId: VALID_ADDRESS }, { "x-api-key": "admin-key" }));
    expect(res.status).toBe(400);
  });

  it("returns 429 with Retry-After once the admin key exceeds the hourly schedule limit", async () => {
    // RATE_LIMIT in route.ts is { limit: 10, windowSeconds: 3600 }.
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        makeRequest({ coinId: VALID_ADDRESS, network: "ethereum" }, { "x-api-key": "admin-key" })
      );
      expect(res.status).toBe(200);
    }

    const eleventh = await POST(
      makeRequest({ coinId: VALID_ADDRESS, network: "ethereum" }, { "x-api-key": "admin-key" })
    );
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toBeTruthy();
  });
});
