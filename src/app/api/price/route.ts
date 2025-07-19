import client from "@/lib/redisConnect";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { coinId, network, startTime } = body;

    if (!coinId || !network || !startTime) {
      return NextResponse.json(
        {
          success: false,
          message: "coinId, network, and startTime are required",
        },
        { status: 400 }
      );
    }

    const cacheKey = `price:${coinId.toLowerCase()}:${network.toLowerCase()}:${startTime}`;
    const cached = await client.get(cacheKey);
    if (cached) {
      console.log("📦 Cache HIT");
      const cachedData = JSON.parse(cached);
      return NextResponse.json({
        success: true,
        status: 200,
        Current: { price: cachedData.currentPrice },
        History: { price: cachedData.historyPrice, method: "cache" },
      });
    }
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
    console.log("Using Alchemy network:", alchemyNetwork);

    let historyPrice: string | undefined;
    let currentPriceData: string | undefined;

    try {
      historyPrice = await fetchHistoricalPrice(
        coinId,
        alchemyNetwork,
        startTime,
        (parseInt(startTime) + 60).toString() // 1 minute after startTime for a range
      );
      console.log("📈 Historical price data:", historyPrice);
    } catch (err) {
      console.error("❌ Error fetching historical price:", err);
      historyPrice = undefined;
    }

    try {
      currentPriceData = await currentPrice(coinId, alchemyNetwork);
      console.log("💰 Current price data:", currentPriceData);
    } catch (err) {
      console.error("❌ Error fetching current price:", err);
      currentPriceData = undefined;
    }

    let finalHistoryPrice: string | number | null = historyPrice ?? null;

    let method = "alchemy";

    if (!historyPrice) {
      console.warn(
        "⚠️ Historical price data is null or undefined, attempting interpolation."
      );
      try {
        const BeforePrice = await fetchHistoricalPrice(
          coinId,
          alchemyNetwork,
          (parseInt(startTime) - 24 * 3600).toString(),
          startTime
        );
        const AfterPrice = await fetchHistoricalPrice(
          coinId,
          alchemyNetwork,
          startTime,
          (parseInt(startTime) + 24 * 3600).toString()
        );
        finalHistoryPrice = interPolatePrice(
          startTime,
          (parseInt(startTime) - 24 * 3600).toString(),
          (parseInt(startTime) + 24 * 3600).toString(),
          BeforePrice,
          AfterPrice
        );
        method = "interpolation";
        console.log("🔄 Interpolated price:", finalHistoryPrice);
      } catch (err) {
        console.error("❌ Error during interpolation fallback:", err);
      
        finalHistoryPrice = currentPriceData || null;
        method = currentPriceData ? "current fallback" : "none";
      }
    }

   
    if (currentPriceData || finalHistoryPrice) {
      const cacheData = {
        currentPrice: currentPriceData,
        historyPrice: finalHistoryPrice,
        method,
      };
      try {
        await client.set(cacheKey, JSON.stringify(cacheData), {
          EX: 60 * 60 * 24, 
        });
      } catch (err) {
        console.error("❌ Error caching price data:", err);
      }
    }

    return NextResponse.json({
      success: true,
      status: 200,
      Current: { price: currentPriceData || null },
      History: { price: finalHistoryPrice || null, method },
    });
  } catch (error) {
    console.error("❌ Error in /api/price:", error);
    return NextResponse.json(
      { success: false, message: "Internal Server Error" },
      { status: 500 }
    );
  }
};



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
  return data?.data?.[0]?.prices?.[0]?.value;
};

const interPolatePrice = (
  currentTime: string,
  beforeTime: string,
  afterTime: string,
  beforePrice: string,
  afterPrice: string
): number => {
  const current = Number(currentTime) * 1000;
  const before = Number(beforeTime) * 1000;
  const after = Number(afterTime) * 1000;

  const beforeP = parseFloat(beforePrice);
  const afterP = parseFloat(afterPrice);

  if (after === before) {
    console.warn("beforeTime and afterTime are equal, returning beforePrice.");
    return Number(beforeP.toFixed(10));
  }

  const timeFraction = Math.min(Math.max((current - before) / (after - before), 0), 1);

  const interpolatedValue = beforeP + timeFraction * (afterP - beforeP);

  return Number(interpolatedValue.toFixed(10));
};

