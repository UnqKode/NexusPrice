// Real MongoDB aggregation pipelines, computing the same statistics as
// src/lib/analytics.ts but inside the database instead of loading the whole
// series into the Node process. analytics.ts is NOT replaced by this file -
// see the note above each function for why each one still exists.
//
// Verified against the live Atlas cluster (MongoDB 8.0.29): $setWindowFields
// + $shift, $dateTrunc with a custom binSize, and $stdDevSamp are all
// supported. $setWindowFields (and therefore $dateTrunc with binSize) needs
// MongoDB 6.0+ - this will not work against an older self-hosted Mongo.
import Price from "@/model/price.model";

export interface SeriesSummary {
  percentChange: number;
  volatility: number;
  min: number;
  max: number;
}

/**
 * Equivalent to analytics.summarize(prices).{percentChange,volatility,min,max}
 * for a range of documents already in Mongo, computed by the database
 * instead of in Node.
 *
 * The $stdDevSamp decision: MongoDB's $stdDevSamp accumulator computes the
 * sample standard deviation of whatever field you point it at. Pointed
 * directly at `price`, that would be a DIFFERENT statistic than
 * analytics.ts's `volatility()` - which is the sample stddev of
 * period-over-period *returns*, not of the prices themselves. To make this
 * pipeline's `volatility` field the same statistic (not just visually
 * similar), a $setWindowFields + $shift computes each document's previous
 * price first, then $stdDevSamp runs over the resulting returns. This is
 * the more expensive of the two options the task allowed (the cheaper one
 * was to point $stdDevSamp at `price` directly and document that it's a
 * different, merely-related statistic) - chosen deliberately so the
 * equivalence test below can assert the two paths produce genuinely
 * identical numbers, not just numbers with the same name.
 */
export async function getSeriesSummary(
  tokenAddress: string,
  network: string,
  from: Date,
  to: Date
): Promise<SeriesSummary> {
  const results = await Price.aggregate([ //mongoDb Pipeline : to transform documetns inside database , on the server , rather than in node
    {
      $match: {
        tokenAddress: tokenAddress.toLowerCase(), // only look at this token address
        network: network.toLowerCase(), // only look for this network
        date: { $gte: from, $lte: to }, // only retrieve data in this date range
      },
    },
    { $sort: { date: 1 } }, // pull them in order oldest first
    {
      $setWindowFields: { // can see its ownfield vs other document near by
        sortBy: { date: 1 },
        output: {
          prevPrice: { $shift: { output: "$price", by: -1 } }, // for each document, look at the previous docuemnt adn copy its price into a new field called prevPrice
        },
      },
    },
    {
      $addFields: { // can only see its own field and does row by row computation
        periodReturn: {
          $cond: [
            { $and: [{ $ne: ["$prevPrice", null] }, { $ne: ["$prevPrice", 0] } ] }, // ne : not equal , so a simple condition that prevprice not null and not zero
            { $divide: [{ $subtract: ["$price", "$prevPrice"] }, "$prevPrice"] }, // then calc how much did the price change since yesterday , as a fraction
            null,
          ],
        },
      },
    },
    {
      $group: { // squash all docuemnt into one
        _id: null,
        min: { $min: "$price" },
        max: { $max: "$price" },
        first: { $first: "$price" },
        last: { $last: "$price" },
        count: { $sum: 1 },
        volatility: { $stdDevSamp: "$periodReturn" },
      },
    },
  ]);

  const row = results[0];
  if (!row) {
    return { percentChange: 0, volatility: 0, min: 0, max: 0 };
  }

  // $stdDevSamp returns null (not 0) when fewer than 2 samples are
  // available - analytics.ts's volatility() returns 0 in that case.
  const volatility = row.volatility == null ? 0 : row.volatility * 100; // the sample standard deviation of preiod over period %
  const percentChange =
    row.count < 2 || row.first === 0 ? 0 : ((row.last - row.first) / row.first) * 100;

  return { percentChange, volatility, min: row.min, max: row.max };
}
/**
 * Equivalent to analytics.simpleMovingAverage(prices, window) for documents
 * already in Mongo. $setWindowFields with a bounded `documents` window is
 * the natural Mongo idiom for a trailing SMA - it replaces the manual
 * index-based loop in analytics.ts.
 *
 * A companion windowCount is used to null out entries before the window has
 * fully filled (analytics.ts returns null for the first `window - 1`
 * entries) - $avg over a documents window happily averages fewer than
 * `window` documents at the start of the series instead of returning null,
 * so without this the two implementations would disagree at the edges.
 */
export async function getMovingAverage(
  tokenAddress: string,
  network: string,
  from: Date,
  to: Date,
  window: number
): Promise<Array<{ date: Date; price: number; sma: number | null }>> {
  const boundedWindow = Math.max(1, Math.floor(window));

  const results = await Price.aggregate([
    {
      $match: {
        tokenAddress: tokenAddress.toLowerCase(),
        network: network.toLowerCase(),
        date: { $gte: from, $lte: to },
      },
    },
    { $sort: { date: 1 } },
    {
      $setWindowFields: {
        sortBy: { date: 1 },
        output: {
          smaRaw: { $avg: "$price", window: { documents: [-(boundedWindow - 1), 0] } },
          windowCount: { $sum: 1, window: { documents: [-(boundedWindow - 1), 0] } },
        },
      },
    },
    {
      $project: {
        _id: 0,
        date: 1,
        price: 1,
        sma: {
          $cond: [{ $gte: ["$windowCount", boundedWindow] }, "$smaRaw", null],
        },
      },
    },
  ]);

  return results;
}

/**
 * Equivalent to the day-bucket-widening loop in
 * src/app/api/historical-prices/route.ts (the `while (startTime < endTime)`
 * loop with a variable `increment`), computed by the database via
 * $dateTrunc's binSize instead of incrementing a JS Date in a loop.
 *
 * $first (after an explicit $sort by date within each bucket) picks the
 * earliest day's price as the bucket's representative value, matching the
 * existing route's semantics of treating a multi-day bucket's price as "the
 * price at the bucket's start date."
 */
export async function getBucketedSeries(
  tokenAddress: string,
  network: string,
  from: Date,
  to: Date,
  bucketDays: number
): Promise<Array<{ date: Date; price: number }>> {
  const boundedBucketDays = Math.max(1, Math.floor(bucketDays));

  const results = await Price.aggregate([
    {
      $match: {
        tokenAddress: tokenAddress.toLowerCase(),
        network: network.toLowerCase(),
        date: { $gte: from, $lte: to },
      },
    },
    { $sort: { date: 1 } },
    {
      $group: {
        _id: { $dateTrunc: { date: "$date", unit: "day", binSize: boundedBucketDays } },
        price: { $first: "$price" },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: "$_id", price: 1 } },
  ]);

  return results;
}
