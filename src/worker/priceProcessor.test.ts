import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const dbConnectMock = vi.fn();
vi.mock("../lib/dbConnect", () => ({
  default: (...args: unknown[]) => dbConnectMock(...args),
}));

const priceFindOneMock = vi.fn();
const priceCreateMock = vi.fn();
vi.mock("../model/price.model", () => ({
  default: {
    findOne: (...args: unknown[]) => priceFindOneMock(...args),
    create: (...args: unknown[]) => priceCreateMock(...args),
  },
}));

// Imported after the mocks above so the module under test picks them up.
const { processor } = await import("./priceProcessor");

function makeJob(data: { coinId: string; network: string }): Job {
  return { data, updateProgress: vi.fn().mockResolvedValue(undefined) } as unknown as Job;
}

function mockFetchSequence(responses: Array<Partial<Response> & { jsonBody?: unknown }>) {
  const impl = vi.fn();
  for (const r of responses) {
    impl.mockImplementationOnce(async () => ({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.jsonBody,
      text: async () => JSON.stringify(r.jsonBody),
    }));
  }
  global.fetch = impl as unknown as typeof fetch;
  return impl;
}

describe("priceProcessor.processor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dbConnectMock.mockReset().mockResolvedValue(undefined);
    priceFindOneMock.mockReset();
    priceCreateMock.mockReset().mockResolvedValue(undefined);
  });

  it("skips a day that already has a stored price (idempotency)", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    mockFetchSequence([
      // findTokenBirthday response - birthday is "today" so the loop runs once
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: todayIso } }] } } },
    ]);
    priceFindOneMock.mockResolvedValue({ _id: "existing" }); // day already saved

    const result = await processor(makeJob({ coinId: "0xabc", network: "ethereum" }));

    expect(result.status).toBe("Completed");
    expect(priceFindOneMock).toHaveBeenCalledTimes(1);
    expect(priceCreateMock).not.toHaveBeenCalled(); // must not re-fetch/re-write an already-known day
  });

  it("fetches and stores a price for a day with no existing record", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: todayIso } }] } } },
      { jsonBody: { data: [{ value: "123.45" }] } }, // fetchPriceForDay
    ]);
    priceFindOneMock.mockResolvedValue(null);

    const result = await processor(makeJob({ coinId: "0xabc", network: "ethereum" }));

    expect(result.status).toBe("Completed");
    expect(priceCreateMock).toHaveBeenCalledTimes(1);
    expect(priceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokenAddress: "0xabc", network: "ethereum", price: 123.45 })
    );
  }, 10_000);

  it("does not write a record when the upstream price fetch returns no data", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    mockFetchSequence([
      { jsonBody: { result: { transfers: [{ metadata: { blockTimestamp: todayIso } }] } } },
      { ok: false, status: 429, jsonBody: { error: "rate limited" } }, // fetchPriceForDay fails
    ]);
    priceFindOneMock.mockResolvedValue(null);

    const result = await processor(makeJob({ coinId: "0xabc", network: "ethereum" }));

    expect(result.status).toBe("Completed"); // the job still "completes" - a missing day is silently skipped
    expect(priceCreateMock).not.toHaveBeenCalled();
  }, 10_000);

  it("throws (fails the job) when the upstream birthday lookup fails, with no internal retry", async () => {
    mockFetchSequence([{ ok: false, status: 500, jsonBody: { error: "boom" } }]);

    await expect(
      processor(makeJob({ coinId: "0xabc", network: "ethereum" }))
    ).rejects.toThrow();

    // Documents a real gap: this function makes no retry attempt itself, and
    // the queue is not configured with `attempts`/`backoff` (see schedule/route.ts),
    // so a single transient upstream failure fails the whole job outright.
    expect(priceCreateMock).not.toHaveBeenCalled();
  });

  it("propagates a DB connection failure as a thrown error, not a process exit", async () => {
    dbConnectMock.mockRejectedValue(new Error("Mongo unreachable"));

    await expect(
      processor(makeJob({ coinId: "0xabc", network: "ethereum" }))
    ).rejects.toThrow("Mongo unreachable");

    // Regression guard for the dbConnect.ts fix: a DB hiccup must fail this
    // job, not call process.exit and take the whole process down with it.
  });
});
