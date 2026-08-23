import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock("../lib/authOptions", () => ({ authOptions: {} }));

const { getServerSession } = await import("next-auth");
const { guardRoute } = await import("./routeGuard");
const { resetApiKeyCacheForTests } = await import("./apiAuth");

class FakeRedis {
  private counts = new Map<string, number>();
  async incr(key: string) {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
  async expire() {
    return 1;
  }
}

class FailingRedis extends FakeRedis {
  async incr(): Promise<number> {
    throw new Error("simulated Redis outage");
  }
}

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/price", { method: "POST", headers });
}

describe("guardRoute", () => {
  const originalApiKeys = process.env.API_KEYS;

  beforeEach(() => {
    resetApiKeyCacheForTests();
    (getServerSession as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    process.env.API_KEYS = "reader-key,admin-key:admin";
  });

  afterEach(() => {
    process.env.API_KEYS = originalApiKeys;
    resetApiKeyCacheForTests();
  });

  it("returns a 401 response when there's no api key or session", async () => {
    const result = await guardRoute(makeRequest(), new FakeRedis(), {
      routeName: "test-route",
      limit: 10,
      windowSeconds: 60,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("passes for a valid read-scoped key on a non-admin route", async () => {
    const result = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), new FakeRedis(), {
      routeName: "test-route",
      limit: 10,
      windowSeconds: 60,
    });
    expect(result.ok).toBe(true);
  });

  it("returns 403 for a read-scoped key on an admin-only route", async () => {
    const result = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), new FakeRedis(), {
      routeName: "test-route",
      limit: 10,
      windowSeconds: 60,
      requireAdmin: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("passes an admin-scoped key on an admin-only route", async () => {
    const result = await guardRoute(makeRequest({ "x-api-key": "admin-key" }), new FakeRedis(), {
      routeName: "test-route",
      limit: 10,
      windowSeconds: 60,
      requireAdmin: true,
    });
    expect(result.ok).toBe(true);
  });

  it("falls back to a dashboard session when no api key is present, treated as admin", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { email: "admin-user" } });

    const result = await guardRoute(makeRequest(), new FakeRedis(), {
      routeName: "test-route",
      limit: 10,
      windowSeconds: 60,
      requireAdmin: true,
    });
    expect(result.ok).toBe(true);
  });

  it("returns 429 once the per-identity limit is exceeded, with rate-limit headers", async () => {
    const redis = new FakeRedis();
    const opts = { routeName: "test-route", limit: 2, windowSeconds: 60 };

    await guardRoute(makeRequest({ "x-api-key": "reader-key" }), redis, opts);
    await guardRoute(makeRequest({ "x-api-key": "reader-key" }), redis, opts);
    const third = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), redis, opts);

    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.response.status).toBe(429);
      expect(third.response.headers.get("Retry-After")).toBeTruthy();
      expect(third.response.headers.get("X-RateLimit-Remaining")).toBe("0");
    }
  });

  it("rate-limits two different api keys independently", async () => {
    const redis = new FakeRedis();
    const opts = { routeName: "test-route", limit: 1, windowSeconds: 60 };

    const first = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), redis, opts);
    const second = await guardRoute(makeRequest({ "x-api-key": "admin-key" }), redis, opts);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true); // different identity, own budget
  });

  it("returns success headers carrying the remaining quota", async () => {
    const result = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), new FakeRedis(), {
      routeName: "test-route",
      limit: 5,
      windowSeconds: 60,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers["X-RateLimit-Limit"]).toBe("5");
      expect(result.headers["X-RateLimit-Remaining"]).toBe("4");
    }
  });

  it("rate-limits the same identity independently per route, not globally", async () => {
    // Regression guard: before routeName was folded into the rate-limit key,
    // two routes sharing the same windowSeconds and the same caller landed
    // on the exact same Redis key at the same windowBucket, so exhausting
    // one route's budget silently exhausted the other's too.
    const redis = new FakeRedis();
    const routeAOpts = { routeName: "route-a", limit: 1, windowSeconds: 60 };
    const routeBOpts = { routeName: "route-b", limit: 1, windowSeconds: 60 };

    const firstOnA = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), redis, routeAOpts);
    const secondOnA = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), redis, routeAOpts);
    const firstOnB = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), redis, routeBOpts);

    expect(firstOnA.ok).toBe(true);
    expect(secondOnA.ok).toBe(false); // route-a's own budget is exhausted
    expect(firstOnB.ok).toBe(true); // route-b has its own, untouched budget
  });

  it("fails open (allows the request) on a Redis error when failClosedOnRedisError is unset", async () => {
    const result = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), new FailingRedis(), {
      routeName: "test-route",
      limit: 10,
      windowSeconds: 60,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed with 503 (not 429) on a Redis error when failClosedOnRedisError is set", async () => {
    const result = await guardRoute(makeRequest({ "x-api-key": "reader-key" }), new FailingRedis(), {
      routeName: "test-route",
      limit: 10,
      windowSeconds: 60,
      failClosedOnRedisError: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(result.response.headers.get("Retry-After")).toBeTruthy();
    }
  });
});
