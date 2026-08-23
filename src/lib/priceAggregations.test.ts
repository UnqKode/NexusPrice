// Proves the MongoDB pipelines in priceAggregations.ts and the pure JS
// functions in analytics.ts agree on the same input. This is deliberately
// NOT mocked: mocking Price.aggregate() would only prove this file's own
// null-handling logic is self-consistent, not that the actual pipeline
// syntax/semantics are correct - which is the entire point of an
// equivalence test. That means this file needs a real MongoDB connection
// (6.0+, for $setWindowFields/$dateTrunc binSize) and is skipped, not
// failed, when one isn't available - see the top-level connectivity check
// below. Run explicitly against real infra with `npm test` when you have a
// MONGODB_URI configured; it's a no-op in environments that don't.
import { describe, it, expect, afterAll } from "vitest";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import Price from "@/model/price.model";
import { getSeriesSummary, getMovingAverage, getBucketedSeries } from "./priceAggregations";
import { summarize, simpleMovingAverage } from "./analytics";

const TEST_TOKEN = "0xequivalencetest00000000000000000000001";
const TEST_NETWORK = "ethereum";
const SERIES_LENGTH = 40;
const START_DATE = new Date("2024-01-01T00:00:00.000Z");

let mongoAvailable = false;
try {
  await mongoose.connect(process.env.MONGODB_URI || "", { serverSelectionTimeoutMS: 4000 });
  mongoAvailable = true;
} catch {
  mongoAvailable = false;
}

interface SeedDoc {
  date: Date;
  price: number;
}
const seeded: SeedDoc[] = [];

if (mongoAvailable) {
  // A deterministic pseudo-random walk, not a monotonic series - a flat or
  // strictly increasing series wouldn't exercise the return/volatility math
  // meaningfully (division by a changing previous price, negative returns).
  let price = 100;
  const docs = [];
  for (let i = 0; i < SERIES_LENGTH; i++) {
    price = price + Math.sin(i * 0.7) * 5 + (i % 3 === 0 ? 2 : -1);
    const date = new Date(START_DATE.getTime() + i * 86_400_000);
    const rounded = Number(price.toFixed(6));
    docs.push({ tokenAddress: TEST_TOKEN, network: TEST_NETWORK, date, price: rounded });
    seeded.push({ date, price: rounded });
  }
  await Price.deleteMany({ tokenAddress: TEST_TOKEN, network: TEST_NETWORK });
  await Price.insertMany(docs);
}

describe.skipIf(!mongoAvailable)("priceAggregations vs analytics.ts equivalence (requires live MongoDB)", () => {
  const rangeStart = START_DATE;
  const rangeEnd = new Date(START_DATE.getTime() + (SERIES_LENGTH - 1) * 86_400_000);

  afterAll(async () => {
    await Price.deleteMany({ tokenAddress: TEST_TOKEN, network: TEST_NETWORK });
    await mongoose.disconnect();
  });

  it("getSeriesSummary matches analytics.summarize on the same data, including volatility", async () => {
    const prices = seeded.map((d) => d.price);
    const jsResult = summarize(prices);
    const dbResult = await getSeriesSummary(TEST_TOKEN, TEST_NETWORK, rangeStart, rangeEnd);

    expect(dbResult.min).toBeCloseTo(jsResult.min, 6);
    expect(dbResult.max).toBeCloseTo(jsResult.max, 6);
    expect(dbResult.percentChange).toBeCloseTo(jsResult.percentChange, 6);
    // The one field worth calling out: this only matches because the
    // pipeline computes period-over-period returns before $stdDevSamp,
    // rather than running $stdDevSamp on price directly (see the comment
    // in priceAggregations.ts). If that comment and this assertion ever
    // disagree, the pipeline was changed without updating the other.
    expect(dbResult.volatility).toBeCloseTo(jsResult.volatility, 6);
  });

  it("getSeriesSummary agrees with analytics.summarize on a narrower sub-range too", async () => {
    const subStart = new Date(START_DATE.getTime() + 10 * 86_400_000);
    const subEnd = new Date(START_DATE.getTime() + 25 * 86_400_000);
    const subPrices = seeded.filter((d) => d.date >= subStart && d.date <= subEnd).map((d) => d.price);

    const jsResult = summarize(subPrices);
    const dbResult = await getSeriesSummary(TEST_TOKEN, TEST_NETWORK, subStart, subEnd);

    expect(dbResult.percentChange).toBeCloseTo(jsResult.percentChange, 6);
    expect(dbResult.volatility).toBeCloseTo(jsResult.volatility, 6);
  });

  it("getMovingAverage matches analytics.simpleMovingAverage, including the null-until-window-fills behavior", async () => {
    const window = 5;
    const prices = seeded.map((d) => d.price);
    const jsSma = simpleMovingAverage(prices, window);
    const dbResult = await getMovingAverage(TEST_TOKEN, TEST_NETWORK, rangeStart, rangeEnd, window);

    expect(dbResult).toHaveLength(jsSma.length);
    dbResult.forEach((point, i) => {
      if (jsSma[i] === null) {
        expect(point.sma).toBeNull();
      } else {
        expect(point.sma).toBeCloseTo(jsSma[i] as number, 6);
      }
    });
  });

  it("returns the zeroed-default shape for a range with no data, matching analytics.summarize([])", async () => {
    const emptyStart = new Date("2099-01-01T00:00:00.000Z");
    const emptyEnd = new Date("2099-01-31T00:00:00.000Z");

    const dbResult = await getSeriesSummary(TEST_TOKEN, TEST_NETWORK, emptyStart, emptyEnd);
    // getSeriesSummary's shape excludes `sma` (that's getMovingAverage's
    // job), so compare against the matching subset of summarize([]) rather
    // than the full AnalyticsSummary shape.
    const { percentChange, volatility, min, max } = summarize([]);

    expect(dbResult).toEqual({ percentChange, volatility, min, max });
  });

  it("getBucketedSeries groups by the requested bin width and picks the earliest day's price per bucket", async () => {
    const bucketDays = 7;
    const result = await getBucketedSeries(TEST_TOKEN, TEST_NETWORK, rangeStart, rangeEnd, bucketDays);

    // 40 days into 7-day bins from an arbitrary start won't divide evenly -
    // assert the shape is sane rather than a specific count.
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(Math.ceil(SERIES_LENGTH / bucketDays) + 1);

    // `point.date` is the $dateTrunc bucket *boundary*, not necessarily any
    // seeded document's own date (this matches the existing route's
    // semantics too - its loop cursor is a computed boundary, not a
    // document date). What must hold is: among seeded docs falling inside
    // [boundary, boundary + bucketDays), the earliest one's price is what
    // got picked as the bucket's representative value.
    for (const point of result) {
      const bucketEnd = new Date(point.date.getTime() + bucketDays * 86_400_000);
      const inBucket = seeded
        .filter((d) => d.date >= point.date && d.date < bucketEnd)
        .sort((a, b) => a.date.getTime() - b.date.getTime());

      expect(inBucket.length).toBeGreaterThan(0);
      expect(point.price).toBeCloseTo(inBucket[0].price, 6);
    }
  });
});
