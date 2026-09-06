// /api/price/....


import client from "@/lib/redisConnect"; // Redis client for caching and single-flight protection
import { getWithSingleFlight } from "@/lib/priceCache"; // Single-flight cache wrapper for price lookups with Redis and in-memory locks
import { interPolatePrice } from "@/lib/interpolation"; // a function to interpolate price between two time points
import { toAlchemyNetwork } from "@/lib/networks";  // map network identifiers to Alchemy's network slugs
import { guardRoute } from "@/lib/routeGuard"; // Rate limiting and request validation for API routes
import { isValidTokenAddress } from "@/lib/validation"; // simple function to validate token addresses using regex pattern
import { logger } from "@/lib/logger"; // simple logger utility for structured logging in the application
import { NextRequest, NextResponse } from "next/server"; // typesafety for Next.js API route request and response objects

const RATE_LIMIT = { routeName: "price", limit: 60, windowSeconds: 60, failClosedOnRedisError: true };
const CURRENT_PRICE_CACHE = {
  softTtlMs: 30 * 1000,
  hardTtlMs: 5 * 60 * 1000,
};

const HISTORY_CACHE = {
  softTtlMs: 30 * 24 * 60 * 60 * 1000,
  hardTtlMs: 30 * 24 * 60 * 60 * 1000,
};

const dayBucket = (unixSeconds: string): number => Math.floor(parseInt(unixSeconds, 10) / 86400) * 86400;

const CACHE_BYPASS_HEADER = "x-bypass-cache";
const CACHE_BYPASS_SOURCE = "bypass-header";

function cacheBypassRequested(request: NextRequest): boolean { // simple function to check if the request has the cache bypass header set to "1" and if the environment variable ALLOW_CACHE_BYPASS is set to "true"
  return process.env.ALLOW_CACHE_BYPASS === "true" && request.headers.get(CACHE_BYPASS_HEADER) === "1";
}

export async function POST(request: NextRequest) { // main entry point for the /api/price POST route, which fetches current and historical price data for a given token address and network, with optional cache bypassing and single-flight protection
  try {
    const guard = await guardRoute(request, client, RATE_LIMIT); // check rate limit and validate request by session or api key, returning a response if the request is not allowed
    if (!guard.ok) return guard.response; // request is not allowed, return the response from the guard

    const body = await request.json();
    const { coinId, network, startTime } = body;

    if (!coinId || !network || !startTime) {  // missing required parameters, return a 400 Bad Request response with an error message
      return NextResponse.json(
        {
          success: false,
          message: "coinId, network, and startTime are required",
        },
        { status: 400, headers: guard.headers }
      );
    }

    if (!isValidTokenAddress(coinId)) { // invalid token address, return a 400 Bad Request response with an error message
      return NextResponse.json(
        { success: false, message: "coinId must be a valid token address (0x + 40 hex chars)" },
        { status: 400, headers: guard.headers }
      );
    }

    const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY; // check if the Alchemy API key is set in the environment variables, return a 500 Internal Server Error response with an error message if not
    if (!ALCHEMY_API_KEY) {
      return NextResponse.json(
        { success: false, message: "Missing Alchemy API key." },
        { status: 500, headers: guard.headers }
      );
    }

    const alchemyNetwork = toAlchemyNetwork(network); // map the netowrk
    const coinKey = coinId.toLowerCase(); 
    const networkKey = network.toLowerCase();

    const currentKey = `price:current:${coinKey}:${networkKey}`;
    const historyKey = `price:hist:${coinKey}:${networkKey}:${dayBucket(startTime)}`;
    const bypassCache = cacheBypassRequested(request);

    let currentPriceData: string | undefined;
    let currentPriceSource: string | undefined;
    try { 
      if (bypassCache) { // if the cache bypass header is set, fetch the current price directly from Alchemy without using the cache or single-flight protection
        currentPriceData = await currentPrice(coinId, alchemyNetwork);
        currentPriceSource = CACHE_BYPASS_SOURCE;
      } else {
        const result = await getWithSingleFlight(  //  fetch the current price using the single-flight cache wrapper, which will either return a cached value or fetch a fresh value from Alchemy and cache it for future requests
          client,
          currentKey,
          () => currentPrice(coinId, alchemyNetwork),
          CURRENT_PRICE_CACHE
        );
        currentPriceData = result.data;
        currentPriceSource = result.source;
      }
    } catch (err) {
      logger.error("❌ Error fetching current price:", err);
      currentPriceData = undefined;
    }

    let finalHistoryPrice: string | number | null = null;
    let method = "none";
    let historySource: string | undefined;

    try {
      if (bypassCache) {
        const result = await fetchHistoryWithFallback(coinId, alchemyNetwork, startTime);
        finalHistoryPrice = result.price;
        method = result.method;
        historySource = CACHE_BYPASS_SOURCE;
      } else {
        const result = await getWithSingleFlight(
          client,
          historyKey,
          () => fetchHistoryWithFallback(coinId, alchemyNetwork, startTime),
          HISTORY_CACHE
        );
        finalHistoryPrice = result.data.price;
        method = result.data.method;
        historySource = result.source;
      }
    } catch (err) {
      logger.warn("⚠️ No history data available even after interpolation fallback:", err);
      finalHistoryPrice = currentPriceData ?? null;
      method = currentPriceData ? "current fallback" : "none";
    }

    // Degraded means the response is HTTP 200 (well-formed JSON, no exception)
    // but doesn't actually carry a usable price - either no history could be
    // resolved even via interpolation, or the current price fetch also failed.
    // Without this flag, every failure mode still reports as a 200, which is
    // why HTTP status code alone cannot be used as an availability signal for
    // this endpoint - see the benchmark harness for how this is measured.
    const degraded = method === "none" || currentPriceData === undefined;

    return NextResponse.json(
      {
        success: true,
        status: 200,
        degraded,
        Current: { price: currentPriceData || null, cache: currentPriceSource },
        History: { price: finalHistoryPrice ?? null, method, cache: historySource },
      },
      { headers: guard.headers }
    );
  } catch (error) {
    logger.error("❌ Error in /api/price:", error);
    return NextResponse.json(
      { success: false, message: "Internal Server Error" },
      { status: 500 }
    );
  }
}

async function fetchHistoryWithFallback(
  coinId: string,
  alchemyNetwork: string,
  startTime: string
): Promise<{ price: string | number; method: string }> {
  let historyPrice: string | undefined;
  try {
    historyPrice = await fetchHistoricalPrice(
      coinId,
      alchemyNetwork,
      startTime,
      (parseInt(startTime) + 60).toString() // 1 minute after startTime for a range
    );
  } catch (err) {
    logger.error("❌ Error fetching historical price:", err);
    historyPrice = undefined;
  }

  if (historyPrice) {
    return { price: historyPrice, method: "alchemy" };
  }

  logger.warn(
    "⚠️ Historical price data is null or undefined, attempting interpolation."
  );

  // Independent requests - run in parallel instead of paying two sequential
  // upstream round trips for what is, from the caller's perspective, one lookup.
  const [beforePrice, afterPrice] = await Promise.all([
    fetchHistoricalPrice(
      coinId,
      alchemyNetwork,
      (parseInt(startTime) - 24 * 3600).toString(),
      startTime
    ),
    fetchHistoricalPrice(
      coinId,
      alchemyNetwork,
      startTime,
      (parseInt(startTime) + 24 * 3600).toString()
    ),
  ]);

  // If either bound is missing (e.g. the queried time is before the token
  // existed), interPolatePrice would silently produce NaN, which serializes
  // to `null` and gets mislabeled as method:"interpolation" - indistinguishable
  // from a real, correct value. Fail loudly instead so the caller falls back
  // to currentPrice/"none" and the `degraded` flag reflects reality.
  if (!beforePrice || !afterPrice) {
    throw new Error(
      `Insufficient data to interpolate: before=${beforePrice} after=${afterPrice}`
    );
  }

  const interpolated = interPolatePrice(
    startTime,
    (parseInt(startTime) - 24 * 3600).toString(),
    (parseInt(startTime) + 24 * 3600).toString(),
    beforePrice,
    afterPrice
  );

  return { price: interpolated, method: "interpolation" };
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

const currentPrice = async (coinId: string, network: string) => {
  const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
  if (!ALCHEMY_API_KEY) {
    throw new Error("Missing Alchemy API key.");
  }

  const url = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-address`;

  const body = {
    addresses: [
      {
        address: coinId,
        network: network,
      },
    ],
  };

  logger.debug("Sending request to Alchemy with body:", body);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  return data?.data?.[0]?.prices?.[0]?.value;
};
