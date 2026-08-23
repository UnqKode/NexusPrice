import client from "@/lib/redisConnect";
import { getWithSingleFlight } from "@/lib/priceCache";
import { interPolatePrice } from "@/lib/interpolation";
import { toAlchemyNetwork } from "@/lib/networks";
import { guardRoute } from "@/lib/routeGuard";
import { isValidTokenAddress } from "@/lib/validation";
import { logger } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";

// Read/lookup route, not admin-only - generous enough for normal dashboard
// use, tight enough to bound a runaway script. See README "API
// authentication and rate limiting" for the full policy across routes.
// failClosedOnRedisError: this route calls Alchemy directly (not via the
// queue) and priceCache also fails open during a Redis outage - so without
// this, an outage would mean every request becomes an unthrottled real
// Alchemy call. See RateLimitOptions.failClosed in rateLimit.ts.
const RATE_LIMIT = { routeName: "price", limit: 60, windowSeconds: 60, failClosedOnRedisError: true };

// "Current" price is volatile - short freshness window, single-flight +
// stale-while-revalidate so a popular token's expiring cache entry doesn't
// cause N concurrent requests to all hit Alchemy at once.
const CURRENT_PRICE_CACHE = {
  softTtlMs: 30 * 1000,
  hardTtlMs: 5 * 60 * 1000,
};

// A historical price for a given past day is immutable once known, so it
// doesn't need revalidation - just a long TTL and single-flight protection
// against a cold-cache stampede the first time a token/day is requested.
const HISTORY_CACHE = {
  softTtlMs: 30 * 24 * 60 * 60 * 1000,
  hardTtlMs: 30 * 24 * 60 * 60 * 1000,
};

const dayBucket = (unixSeconds: string): number =>
  Math.floor(parseInt(unixSeconds, 10) / 86400) * 86400;

// Lets the benchmark harness (scripts/benchmark.mjs) measure genuine
// uncached upstream latency as a real "before" number, not an inferred one -
// without this there's no way to see what a request costs with the cache
// infrastructure completely out of the picture, only "first request" (cold),
// which still pays Redis GET/lock-acquire overhead on the way to the miss.
// Gated behind an env var so the header has no effect at all unless the
// operator explicitly opts in - a caller can send x-bypass-cache on a
// production deployment with ALLOW_CACHE_BYPASS unset and it's a silent
// no-op, not a way to force-drain Alchemy quota on demand.
const CACHE_BYPASS_HEADER = "x-bypass-cache";
const CACHE_BYPASS_SOURCE = "bypass-header";

function cacheBypassRequested(request: NextRequest): boolean {
  return process.env.ALLOW_CACHE_BYPASS === "true" && request.headers.get(CACHE_BYPASS_HEADER) === "1";
}

export async function POST(request: NextRequest) {
  try {
    const guard = await guardRoute(request, client, RATE_LIMIT);
    if (!guard.ok) return guard.response;

    const body = await request.json();
    const { coinId, network, startTime } = body;

    if (!coinId || !network || !startTime) {
      return NextResponse.json(
        {
          success: false,
          message: "coinId, network, and startTime are required",
        },
        { status: 400, headers: guard.headers }
      );
    }

    if (!isValidTokenAddress(coinId)) {
      return NextResponse.json(
        { success: false, message: "coinId must be a valid token address (0x + 40 hex chars)" },
        { status: 400, headers: guard.headers }
      );
    }

    const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
    if (!ALCHEMY_API_KEY) {
      return NextResponse.json(
        { success: false, message: "Missing Alchemy API key." },
        { status: 500, headers: guard.headers }
      );
    }

    const alchemyNetwork = toAlchemyNetwork(network);
    const coinKey = coinId.toLowerCase();
    const networkKey = network.toLowerCase();

    const currentKey = `price:current:${coinKey}:${networkKey}`;
    const historyKey = `price:hist:${coinKey}:${networkKey}:${dayBucket(startTime)}`;
    const bypassCache = cacheBypassRequested(request);

    let currentPriceData: string | undefined;
    let currentPriceSource: string | undefined;
    try {
      if (bypassCache) {
        currentPriceData = await currentPrice(coinId, alchemyNetwork);
        currentPriceSource = CACHE_BYPASS_SOURCE;
      } else {
        const result = await getWithSingleFlight(
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
