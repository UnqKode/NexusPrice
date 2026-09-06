// /api/historical-prices/..


import client from "@/lib/redisConnect"; // a redis connection is served , if it was already connected the previous connection is served
import { summarize, simpleMovingAverage } from "@/lib/analytics"; // served summary and simpleMoving Average
import { getSeriesSummary } from "@/lib/priceAggregations"; //returns percentage change, min , max , volitality
import { computeHistoricalRange } from "@/lib/dateRange"; // return [starts, increment] 
import dbConnect from "@/lib/dbConnect"; // mongoDb connection
import Price from "@/model/price.model"; // [tokenAddress,network,date,price]
import { toAlchemyNetwork } from "@/lib/networks"; // a simple map for network name for eg: ethereum: "eth-mainnet"
import { guardRoute } from "@/lib/routeGuard"; // serves a function comprising of rate limit and authentication via session token or api key 
import { isValidTokenAddress } from "@/lib/validation"; // checks for valid token address using regex pattern
import { logger } from "@/lib/logger"; // a simple logger instance with debug, info, warn, and error methods
import { NextRequest, NextResponse } from "next/server"; // typesafety 

interface HistoricalPricePoint {
  date: string;
  price: string | number;
  method?: string;
  sma?: number | null;
}

const RATE_LIMIT = {
  routeName: "historical-prices",
  limit: 20,
  windowSeconds: 60,
  failClosedOnRedisError: true,
};

export async function POST(request: NextRequest) {
  try {
    const guard = await guardRoute(request, client, RATE_LIMIT);
    if (!guard.ok) return guard.response; // checks for authentication and rate limit, if not ok -> returns the response with status code and message

    const body = await request.json();
    const { tokenAddress, network, timeRange } = body;

    if (!tokenAddress || !network || !timeRange) { // incomplete request body, return 400 with message
      return NextResponse.json(
        {
          success: false,
          message: "Fill all fields",
        },
        { status: 400, headers: guard.headers }
      );
    }

    if (!isValidTokenAddress(tokenAddress)) { // invalid token address, return 400 with message
      return NextResponse.json(
        { success: false, message: "tokenAddress must be a valid token address (0x + 40 hex chars)" },
        { status: 400, headers: guard.headers }
      );
    }

    const now = new Date();
    const { start: rangeComputedStart, increment } = computeHistoricalRange(timeRange, now); // returns the start date and increment for the given time range and current date
    let startTime = rangeComputedStart;
    const endTime = new Date();
    const rangeStart = new Date(startTime);
    rangeStart.setUTCHours(0, 0, 0, 0);
    const dbPriceByDay = new Map<string, number>();
    try {
      await dbConnect();
      const tokenLower = tokenAddress.toLowerCase();
      const networkLower = network.toLowerCase();
      const docs = await Price.find(
        { tokenAddress: tokenLower, network: networkLower, date: { $gte: rangeStart, $lte: endTime } },
        { date: 1, price: 1 }
      ).lean(); // .lean() returns plain JS objects instead of Mongoose documents, which is more efficient for read-only queries
      for (const doc of docs) {
        dbPriceByDay.set(doc.date.toISOString(), doc.price);
      }
    } catch (err) {
      logger.warn("⚠️ Mongo lookup failed, falling back to Redis/Alchemy only:", err);
    }

    const result: HistoricalPricePoint[] = [];
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

    const resolvedEntries = result.filter( // remove invalid price entries (undefined, null, NaN) from the result array
      (entry) => entry.price !== undefined && entry.price !== null && !isNaN(parseFloat(String(entry.price)))
    );
    const numericPrices = resolvedEntries.map((entry) => parseFloat(String(entry.price))); // convert the price to a number for analytics calculations

    const smaSeries = simpleMovingAverage(numericPrices, 5); // caluclate the simple moving average for the price series with a window of 5
    resolvedEntries.forEach((entry, i) => {
      entry.sma = smaSeries[i];
    });

    let summaryStats: { percentChange: number; volatility: number; min: number; max: number };
    let summarySource: "pipeline" | "js";

    const jsSummaryStats = (): { percentChange: number; volatility: number; min: number; max: number } => {
      const { percentChange, volatility, min, max } = summarize(numericPrices, 5);
      return { percentChange, volatility, min, max };
    };

    if (allFromDb && resolvedEntries.length > 0) {
      try {
        summaryStats = await getSeriesSummary(tokenAddress, network, rangeStart, endTime);  //mongodb aggregation pipeline to calculate percentChange, volatility, min, max for the price series
        summarySource = "pipeline";
      } catch (err) {
        logger.warn("⚠️ Aggregation pipeline failed, falling back to JS analytics:", err); // js function to calculate percentChange, volatility, min, max for the price series
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
    signal: AbortSignal.timeout(8_000), // 8 seconds timeout for the request
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
