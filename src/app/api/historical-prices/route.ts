// /api/historical-prices/..


import client from "@/lib/redisConnect"; // a redis connection is served , if it was already connected the previous connection is served
import { summarize, simpleMovingAverage } from "@/lib/analytics"; // served summary and simpleMoving Average
import { getSeriesSummary } from "@/lib/priceAggregations"; //returns percentage change, min , max , volitality
import { computeHistoricalRange } from "@/lib/dateRange"; // return [starts, increment] 
import dbConnect from "@/lib/dbConnect"; // mongoDb connection
import Price from "@/model/price.model"; // [tokenAddress,network,date,price]
import { toAlchemyNetwork } from "@/lib/networks"; // a simple map for network name for eg: ethereum: "eth-mainnet"
import { guardRoute } from "@/lib/routeGuard";
import { isValidTokenAddress } from "@/lib/validation";
import { logger } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";

interface HistoricalPricePoint {
  date: string;
  price: string | number;
  method?: string;
  sma?: number | null;
}

// Tighter than /api/price - one request here can amplify into up to ~36
// sequential Alchemy calls (a 3y range at a 30-day bucket increment) when
// nothing is cached, vs. /api/price's fixed 1-2 calls per request.
// failClosedOnRedisError: see the same note in src/app/api/price/route.ts -
// this route can amplify to ~36 direct Alchemy calls per request, making the
// combination of "no rate limit" + "cache also bypassed" during a Redis
// outage even more dangerous for the shared quota than /api/price's case.
const RATE_LIMIT = {
  routeName: "historical-prices",
  limit: 20,
  windowSeconds: 60,
  failClosedOnRedisError: true,
};

export async function POST(request: NextRequest) {
  try {
    const guard = await guardRoute(request, client, RATE_LIMIT);
    if (!guard.ok) return guard.response;

    const body = await request.json();
    const { tokenAddress, network, timeRange } = body;

    if (!tokenAddress || !network || !timeRange) {
      return NextResponse.json(
        {
          success: false,
          message: "Fill all fields",
        },
        { status: 400, headers: guard.headers }
      );
    }

    if (!isValidTokenAddress(tokenAddress)) {
      return NextResponse.json(
        { success: false, message: "tokenAddress must be a valid token address (0x + 40 hex chars)" },
        { status: 400, headers: guard.headers }
      );
    }

    const now = new Date();

    // UTC-anchored (see dateRange.ts) - local-time equivalents here would
    // silently shift every computed boundary depending on the server
    // process's timezone, which is exactly the class of bug the adversarial
    // test suite (dateRange.adversarial-tz.test.ts) exists to catch.
    const { start: rangeComputedStart, increment } = computeHistoricalRange(timeRange, now);
    let startTime = rangeComputedStart;

    // Not truncated to midnight, unlike rangeStart below - safe only because
    // "now" is always later than any stored document's UTC-midnight
    // timestamp for the same day, which holds as long as this process's
    // clock and the worker's clock are reasonably aligned (see rangeEnd's
    // $lte usage a few lines down).
    const endTime = new Date();

    // Range boundaries for the one-shot Mongo query below. `startTime` is
    // reused as the mutable loop cursor further down, so its current value
    // (the range start computed above) has to be captured into its own
    // variable now, before the loop starts reassigning it.
    //
    // Truncated to UTC midnight - `startTime` carries the current
    // time-of-day (it was built from `new Date()`, not a midnight-aligned
    // date), but documents are stored at exact UTC midnight, one per day
    // (see priceProcessor.ts). Querying with a non-midnight lower bound
    // (e.g. 08-09T20:35:00Z) would exclude that same day's midnight
    // document (08-09T00:00:00Z) even though it's the same calendar day -
    // found live, by seeding real data and hitting the route end to end,
    // not by the mocked tests (which construct already-midnight-aligned
    // dates and so never exercised this edge).
    const rangeStart = new Date(startTime);
    rangeStart.setUTCHours(0, 0, 0, 0);

    // One query for the whole range instead of one per bucket, keyed by
    // day so it lines up with how the worker stores documents (one per UTC
    // day - see priceProcessor.ts). Mongo is treated as an optional
    // accelerant here, not a hard dependency: this endpoint worked without
    // it before, so a connection failure falls back to the Redis/Alchemy
    // path that already existed rather than failing the whole request.
    const dbPriceByDay = new Map<string, number>();
    try {
      await dbConnect();
      const tokenLower = tokenAddress.toLowerCase();
      const networkLower = network.toLowerCase();
      const docs = await Price.find(
        { tokenAddress: tokenLower, network: networkLower, date: { $gte: rangeStart, $lte: endTime } },
        { date: 1, price: 1 }
      ).lean();
      for (const doc of docs) {
        dbPriceByDay.set(doc.date.toISOString(), doc.price);
      }
    } catch (err) {
      logger.warn("⚠️ Mongo lookup failed, falling back to Redis/Alchemy only:", err);
    }

    const result: HistoricalPricePoint[] = [];
    // Tracks whether every single bucket resolved from Mongo, not Redis or
    // Alchemy - see the summary computation after the loop for why this
    // decides which of the two implementations computes percentChange/
    // volatility/min/max for this response.
    let allFromDb = true;

    while (startTime < endTime) {
      const cacheKey = `price:${tokenAddress.toLowerCase()}:${network.toLowerCase()}:${startTime.toISOString()}`;
      const cached = await client.get(cacheKey);

      const dayKey = new Date(startTime);
      dayKey.setUTCHours(0, 0, 0, 0);
      const dbPrice = dbPriceByDay.get(dayKey.toISOString());

      if (cached) {
        logger.debug("📦 Cache HIT");
        allFromDb = false;
        const cachedData = JSON.parse(cached);
        result.push({
          // Explicit UTC timezone - without it, this label is formatted in
          // the server process's local timezone, which can show a date one
          // day off from the UTC day the underlying price actually belongs
          // to (see dateRange.ts for the same class of bug affecting the
          // range computation itself).
          date: startTime.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }),
          price: cachedData.historyPrice,
          method: "cache",
        });
      } else if (dbPrice !== undefined) {
        logger.debug("🗄️ DB HIT");
        result.push({
          // Explicit UTC timezone - without it, this label is formatted in
          // the server process's local timezone, which can show a date one
          // day off from the UTC day the underlying price actually belongs
          // to (see dateRange.ts for the same class of bug affecting the
          // range computation itself).
          date: startTime.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }),
          price: dbPrice,
          method: "db",
        });
      } else {
        logger.debug("❌ Cache MISS");
        allFromDb = false;
        const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
        if (!ALCHEMY_API_KEY) {
          return NextResponse.json(
            { success: false, message: "Missing Alchemy API key." },
            { status: 500, headers: guard.headers }
          );
        }

        const alchemyNetwork = toAlchemyNetwork(network);

        const startTimeUnix = Math.floor(startTime.getTime() / 1000); // seconds
        const endTimeUnix = startTimeUnix + Math.floor(increment / 1000);

        try {
          const historyPrice = await fetchHistoricalPrice(
            tokenAddress,
            alchemyNetwork,
            startTimeUnix.toString(),
            endTimeUnix.toString()
          );
          logger.debug("📈 Historical price data:", historyPrice);

          result.push({
            // Explicit UTC timezone - see the other two occurrences of this
            // label above for why.
            date: startTime.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            }),
            price: historyPrice,
            method: "alchemy",
          });
          logger.debug(result);

          await client.set(
            cacheKey,
            JSON.stringify({ historyPrice }),
            { EX: 3600 * 24 }
          );
        } catch (err) {
          logger.error("❌ Error fetching historical price:", err);

        }
      }

      startTime = new Date(startTime.getTime() + increment);
    }

    // Some buckets may be missing a price (upstream fetch failed for that
    // day - see the catch block above, which silently skips rather than
    // recording a gap). Only compute analytics over buckets that actually
    // resolved to a real number, and attach the matching SMA value back onto
    // those same entries so the series and its moving average stay aligned.
    const resolvedEntries = result.filter(
      (entry) => entry.price !== undefined && entry.price !== null && !isNaN(parseFloat(String(entry.price)))
    );
    const numericPrices = resolvedEntries.map((entry) => parseFloat(String(entry.price)));

    // SMA is always computed over the series actually displayed (which may
    // be bucketed into 5/10/30-day points for longer ranges), the same way
    // in both paths below - the aggregation pipeline's getMovingAverage
    // operates on raw daily documents, and mixing "SMA over daily data"
    // into a chart whose x-axis is 30-day buckets would be a different,
    // confusing statistic, not a faithful equivalent.
    const smaSeries = simpleMovingAverage(numericPrices, 5);
    resolvedEntries.forEach((entry, i) => {
      entry.sma = smaSeries[i];
    });

    // percentChange/volatility/min/max: use the MongoDB pipeline, computed
    // over full daily-resolution documents, only when every bucket in this
    // response actually came from Mongo - i.e. we know the full backing
    // data exists there, not just the sparse/bucketed points being
    // displayed. Otherwise (any cache or Alchemy involvement) fall back to
    // the JS path over the same resolved series used for the chart, as
    // before. These two paths can report different numbers for the same
    // token on a coarse (1m/3m/6m/1y/3y) view, because the pipeline sees
    // every day and the JS path only sees the bucketed sample - that's a
    // real, deliberate behavior difference, not a bug: full-day-resolution
    // stats are more accurate when they're available for free.
    let summaryStats: { percentChange: number; volatility: number; min: number; max: number };
    let summarySource: "pipeline" | "js";

    // Picked explicitly (not just narrowly typed) because summarize()'s
    // return value has an extra `sma` field at runtime - TypeScript's
    // excess-property checks don't strip it just because the variable it's
    // assigned to is typed more narrowly, so without this the JS path would
    // leak a redundant summary.sma array that the pipeline path doesn't have.
    const jsSummaryStats = (): { percentChange: number; volatility: number; min: number; max: number } => {
      const { percentChange, volatility, min, max } = summarize(numericPrices, 5);
      return { percentChange, volatility, min, max };
    };

    if (allFromDb && resolvedEntries.length > 0) {
      try {
        summaryStats = await getSeriesSummary(tokenAddress, network, rangeStart, endTime);
        summarySource = "pipeline";
      } catch (err) {
        logger.warn("⚠️ Aggregation pipeline failed, falling back to JS analytics:", err);
        summaryStats = jsSummaryStats();
        summarySource = "js";
      }
    } else {
      summaryStats = jsSummaryStats();
      summarySource = "js";
    }

    return NextResponse.json(
      {
        success: true,
        status: 200,
        data: result,
        summary: {
          ...summaryStats,
          source: summarySource,
        },
        message: "Historical prices fetched successfully",
      },
      { headers: guard.headers }
    );
  } catch (error) {
    logger.error("❌ Error in /api/historical-prices:", error);
    return NextResponse.json(
      { success: false, message: "Internal Server Error" },
      { status: 500 }
    );
  }
}

const fetchHistoricalPrice = async (
  coinId: string,
  network: string,
  startTime: string,
  endTime: string
) => {
  const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
  if (!ALCHEMY_API_KEY) {
    throw new Error("Missing Alchemy API key.");
  }

  const url = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`;

  const body = {
    address: coinId,
    network: network,
    startTime: new Date(parseInt(startTime) * 1000).toISOString(),
    endTime: new Date(parseInt(endTime) * 1000).toISOString(),
  };

  logger.debug("Sending request to Alchemy with body:", body);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Below priceCache's lockTtlMs (10s default) - a hung Alchemy call must
    // fail before it could hold a single-flight lock for its full duration.
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json();
    logger.error("🔴 Alchemy API error response:", errorData);
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  logger.debug(
    "✅ Full Alchemy API response received:",
    JSON.stringify(data, null, 2)
  );
  return data?.data?.[0]?.value;
};
