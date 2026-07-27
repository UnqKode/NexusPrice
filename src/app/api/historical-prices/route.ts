import client from "@/lib/redisConnect";
import { summarize } from "@/lib/analytics";
import { NextRequest, NextResponse } from "next/server";

interface HistoricalPricePoint {
  date: string;
  price: string | number;
  method?: string;
  sma?: number | null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tokenAddress, network, timeRange } = body;

    if (!tokenAddress || !network || !timeRange) {
      return NextResponse.json(
        {
          success: false,
          message: "Fill all fields",
        },
        { status: 400 }
      );
    }

    const now = new Date();

    let startTime = new Date();
    let increment = 24 * 60 * 60 * 1000;

    switch (timeRange) {
      case "1w":
        startTime.setDate(now.getDate() - 7);
        increment = 24 * 60 * 60 * 1000; 
        break;

      case "1m":
        startTime.setMonth(now.getMonth() - 1);
        increment = 5 * 24 * 60 * 60 * 1000; 
        break;

      case "3m":
        startTime.setMonth(now.getMonth() - 3);
        increment = 10 * 24 * 60 * 60 * 1000; 
        break;

      case "6m":
        startTime.setMonth(now.getMonth() - 6);
        increment = 30 * 24 * 60 * 60 * 1000; 
        break;

      case "1y":
        startTime.setFullYear(now.getFullYear() - 1);
        increment = 30 * 24 * 60 * 60 * 1000; 
        break;

      case "3y":
        startTime.setFullYear(now.getFullYear() - 3);
        increment = 30 * 24 * 60 * 60 * 1000; 
        break;

      default:
        startTime.setDate(now.getDate() - 7);
        increment = 24 * 60 * 60 * 1000; 
    }

  

   
    const endTime = new Date();

    const result: HistoricalPricePoint[] = [];

    while (startTime < endTime) {
      const cacheKey = `price:${tokenAddress.toLowerCase()}:${network.toLowerCase()}:${startTime.toISOString()}`;
      const cached = await client.get(cacheKey);

      if (cached) {
        console.log("📦 Cache HIT");
        const cachedData = JSON.parse(cached);
        result.push({
          date: startTime.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          price: cachedData.historyPrice,
          method: "cache",
        });
      } else {
        console.log("❌ Cache MISS");
        const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
        if (!ALCHEMY_API_KEY) {
          return NextResponse.json(
            { success: false, message: "Missing Alchemy API key." },
            { status: 500 }
          );
        }

        const networkMap: Record<string, string> = {
          ethereum: "eth-mainnet",
          polygon: "polygon-mainnet",
          arbitrum: "arb-mainnet",
          optimism: "opt-mainnet",
          base: "base-mainnet",
          bsc: "bsc-mainnet",
          avalanche: "avax-mainnet",
        };

        const alchemyNetwork = networkMap[network.toLowerCase()] || network;

        const startTimeUnix = Math.floor(startTime.getTime() / 1000); // seconds
        const endTimeUnix = startTimeUnix + Math.floor(increment / 1000);

        try {
          const historyPrice = await fetchHistoricalPrice(
            tokenAddress,
            alchemyNetwork,
            startTimeUnix.toString(),
            endTimeUnix.toString()
          );
          console.log("📈 Historical price data:", historyPrice);

          result.push({
            date: startTime.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
            price: historyPrice,
          });
          console.log(result);
         
          await client.set(
            cacheKey,
            JSON.stringify({ historyPrice }),
            { EX: 3600 * 24 }
          );
        } catch (err) {
          console.error("❌ Error fetching historical price:", err);
         
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
    const analytics = summarize(numericPrices, 5);
    resolvedEntries.forEach((entry, i) => {
      entry.sma = analytics.sma[i];
    });

    return NextResponse.json({
      success: true,
      status: 200,
      data: result,
      summary: {
        percentChange: analytics.percentChange,
        volatility: analytics.volatility,
        min: analytics.min,
        max: analytics.max,
      },
      message: "Historical prices fetched successfully",
    });
  } catch (error) {
    console.error("❌ Error in /api/price:", error);
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

  console.log("Sending request to Alchemy with body:", body);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json();
    console.error("🔴 Alchemy API error response:", errorData);
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  console.log(
    "✅ Full Alchemy API response received:",
    JSON.stringify(data, null, 2)
  );
  return data?.data?.[0]?.value;
};
