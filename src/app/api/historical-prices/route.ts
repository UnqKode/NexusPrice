import client from "@/lib/redisConnect";
import { NextRequest, NextResponse } from "next/server";

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
        increment = 24 * 60 * 60 * 1000; // 1 day in ms
        break;

      case "1m":
        startTime.setMonth(now.getMonth() - 1);
        increment = 5 * 24 * 60 * 60 * 1000; // 5 days in ms
        break;

      case "3m":
        startTime.setMonth(now.getMonth() - 3);
        increment = 10 * 24 * 60 * 60 * 1000; // 10 days in ms
        break;

      case "6m":
        startTime.setMonth(now.getMonth() - 6);
        increment = 30 * 24 * 60 * 60 * 1000; // 1 month ≈ 30 days in ms
        break;

      case "1y":
        startTime.setFullYear(now.getFullYear() - 1);
        increment = 30 * 24 * 60 * 60 * 1000; // 1 month ≈ 30 days in ms
        break;

      case "3y":
        startTime.setFullYear(now.getFullYear() - 3);
        increment = 30 * 24 * 60 * 60 * 1000; // 1 month ≈ 30 days in ms
        break;

      default:
        startTime.setDate(now.getDate() - 7);
        increment = 24 * 60 * 60 * 1000; // 1 day in ms
    }

  

    // Convert to ISO string or UNIX timestamp if needed
    const startTimeISO = startTime.toISOString();
    const endTime = new Date(); // current date and time

    const result = [];

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
          // Cache it for next time (optional)
          await client.set(
            cacheKey,
            JSON.stringify({ historyPrice }),
            { EX: 3600 * 24 } // expire in 24h (optional)
          );
        } catch (err) {
          console.error("❌ Error fetching historical price:", err);
          // You might want to push a null or skip here to continue loop
        }
      }

      startTime = new Date(startTime.getTime() + increment);
    }

    // Cache the data if prices are available

    return NextResponse.json({
      success: true,
      status: 200,
      data: result,
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

export const fetchHistoricalPrice = async (
  coinId: string,
  network: string,
  startTime: string,
  endTime: string
): Promise<any> => {
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
