// Pure job-processing logic, deliberately separated from src/worker/priceWorker.ts
// (the entrypoint that instantiates a real BullMQ Worker). Importing *this*
// file has no side effects - no Redis connection, no queue consumption - so
// it can be imported directly in tests.
import { Job } from "bullmq";
import dbConnect from "../lib/dbConnect";
import Price from "../model/price.model";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

const NETWORK_MAP: Record<string, string> = {
  ethereum: "eth-mainnet",
  polygon: "polygon-mainnet",
  arbitrum: "arb-mainnet",
  optimism: "opt-mainnet",
};

export const findTokenBirthday = async (
  coinId: string,
  network: string
): Promise<Date> => {
  const alchemyNetwork = NETWORK_MAP[network.toLowerCase()] || network;
  const url = `https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getAssetTransfers",
        params: [
          {
            fromBlock: "0x0",
            contractAddresses: [coinId],
            maxCount: "0x1",
            order: "asc",
            category: ["erc20"],
            withMetadata: true,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Alchemy API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const timestamp = data?.result?.transfers?.[0]?.metadata?.blockTimestamp;

    if (!timestamp) {
      throw new Error(`No creation date found for token ${coinId}`);
    }

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      throw new Error(
        `Invalid timestamp received for token ${coinId}: ${timestamp}`
      );
    }

    return date;
  } catch (error) {
    console.error(`Error finding token birthday:`, error);
    throw error;
  }
};

export const fetchPriceForDay = async (
  coinId: string,
  network: string,
  date: Date
): Promise<number | null> => {
  const alchemyNetwork = NETWORK_MAP[network.toLowerCase()] || network;
  const url = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`;

  try {
    const startTimeUnix = Math.floor(date.getTime() / 1000);
    const endTimeUnix = startTimeUnix + 24 * 3600;

    const body = {
      address: coinId,
      network: alchemyNetwork,
      startTime: new Date(startTimeUnix * 1000).toISOString(),
      endTime: new Date(endTimeUnix * 1000).toISOString(),
      currency: "usd",
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`🔴 Alchemy API error response:`, JSON.stringify(errorData, null, 2));
      return null;
    }

    const data = await response.json();
    const priceStr = data?.data?.[0]?.value;
    if (!priceStr) {
      return null;
    }

    const price = parseFloat(priceStr);
    if (isNaN(price)) {
      return null;
    }

    return price;
  } catch (error) {
    console.error(`❌ Error fetching price for ${date.toISOString()}:`, error);
    return null;
  }
};

export const processor = async (
  job: Job
): Promise<{ coinId: string; network: string; status: string }> => {
  const { coinId, network } = job.data;

  try {
    await dbConnect();

    const birthday = await findTokenBirthday(coinId, network);

    const startDate = new Date(birthday.setUTCHours(0, 0, 0, 0));
    const today = new Date(new Date().setUTCHours(0, 0, 0, 0));
    const totalDays =
      Math.round((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;

    const currentDate = new Date(startDate);
    let processedDays = 0;
    let savedPrices = 0;

    while (currentDate <= today) {
      const existingPrice = await Price.findOne({
        tokenAddress: coinId,
        network,
        date: currentDate,
      });

      if (!existingPrice) {
        const price = await fetchPriceForDay(coinId, network, new Date(currentDate));

        if (price !== null) {
          await Price.create({
            tokenAddress: coinId,
            network,
            date: currentDate,
            price,
          });
          savedPrices++;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      processedDays++;
      // Surfaced by GET /api/schedule/status so a scheduled backfill isn't a
      // black box - this is the one BullMQ job property that was never
      // reported anywhere before.
      await job.updateProgress({
        processedDays,
        totalDays,
        savedPrices,
        percent: Math.round((processedDays / totalDays) * 100),
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log(
      `🎉 Finished processing ${coinId} on ${network}. Processed ${processedDays} days, saved ${savedPrices} new prices.`
    );
    return { coinId, network, status: "Completed" };
  } catch (error) {
    console.error(`❌ Error processing job for ${coinId} on ${network}:`, error);
    throw error;
  }
};
