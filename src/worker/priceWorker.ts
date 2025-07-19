// workers/priceWorker.ts



//since worker is not a Next.js page, we need to import dotenv manually and i will be running this file on another server as its need to keep listing from the queue

import { Worker, Job } from "bullmq";
import dbConnect from "../lib/dbConnect";
import Price from "../model/price.model";

const QUEUE_NAME = "price-history-queue";
const ALCHEMY_API_KEY = "kgv-WByysbnlxX39aMv9bvmFUNH1dUqb";

if (!ALCHEMY_API_KEY) {
  throw new Error("ALCHEMY_API_KEY is not defined in environment variables");
}

const connection = {
  host: process.env.REDIS_HOST ,
  port: process.env.REDIS_PORT ,
  password: process.env.REDIS_PASSWORD,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  keepAlive: true,
};

// Network mapping for Alchemy
const NETWORK_MAP: Record<string, string> = {
  ethereum: "eth-mainnet",
  polygon: "polygon-mainnet",
  arbitrum: "arb-mainnet",
  optimism: "opt-mainnet",
};

// --- Helper Function: Find Token Creation Date ---
const findTokenBirthday = async (
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
    console.log(data.result.transfers[0].metadata.blockTimestamp);
    const timestamp = data?.result?.transfers?.[0]?.metadata?.blockTimestamp;

    if (!timestamp) {
      throw new Error(`No creation date found for token ${coinId}`);
    }

    // Ensure timestamp is a valid date string
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

// --- Helper Function: Fetch Price for a Specific Day ---


// --- Helper Function: Fetch Price for a Specific Day ---
const fetchPriceForDay = async (
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

    console.log(
      `[${new Date().toISOString()}] fetchPriceForDay: Sending request to Alchemy with body:`,
      JSON.stringify(body, null, 2)
    );

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    console.log(`[${new Date().toISOString()}] fetchPriceForDay: Response status ${response.status}`);

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`[${new Date().toISOString()}] 🔴 Alchemy API error response:`, JSON.stringify(errorData, null, 2));
      return null;
    }

    const data = await response.json();
    console.log(`[${new Date().toISOString()}] ✅ Full Alchemy API response:`, JSON.stringify(data, null, 2));

    const priceStr = data?.data?.[0]?.value;
    if (!priceStr) {
      console.warn(`[${new Date().toISOString()}] ⚠️ Price not found in response data.`);
      return null;
    }

    const price = parseFloat(priceStr);
    if (isNaN(price)) {
      console.warn(`[${new Date().toISOString()}] ⚠️ Price is not a valid number: ${priceStr}`);
      return null;
    }

    console.log(`[${new Date().toISOString()}] 💰 Price fetched for ${coinId} on ${body.startTime}: $${price}`);
    return price;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${date.toISOString()}:`, error);
    return null;
  }
};


// --- Main Worker Logic ---
const processor = async (
  job: Job
): Promise<{ coinId: string; network: string; status: string }> => {
  const { coinId, network } = job.data;
  console.log(`🔧 Starting processing job for token ${coinId} on network ${network}...`);

  try {
    console.log("⏳ Connecting to the database...");
    await dbConnect();
    console.log("✅ Database connected.");

    const birthday = await findTokenBirthday(coinId, network);
    console.log(`🎂 Token ${coinId} was created on: ${birthday.toISOString()}`);

    // Set start and end dates to midnight UTC
    const startDate = new Date(birthday.setUTCHours(0, 0, 0, 0));
    const today = new Date(new Date().setUTCHours(0, 0, 0, 0));
    console.log(`📅 Fetching prices from ${startDate.toISOString()} to ${today.toISOString()}`);

    const currentDate = new Date(startDate);
    let processedDays = 0;
    let savedPrices = 0;

    while (currentDate <= today) {
      const dateStr = currentDate.toISOString().split("T")[0];
      console.log(`🔍 Checking price data for ${dateStr}...`);

      // Check for existing price record
      const existingPrice = await Price.findOne({
        tokenAddress: coinId,
        network,
        date: currentDate,
      });

      if (existingPrice) {
        console.log(`⏩ Price data already exists for ${dateStr}, skipping.`);
      } else {
        console.log(`🚀 Fetching price for ${dateStr}...`);
        const price = await fetchPriceForDay(coinId, network, new Date(currentDate));

        if (price !== null) {
          await Price.create({
            tokenAddress: coinId,
            network,
            date: currentDate,
            price,
          });
          savedPrices++;
          console.log(`✅ Saved price for ${dateStr}: $${price}`);
        } else {
          console.log(`⚠️ No price data found for ${dateStr}`);
        }

        // Wait a bit between requests to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      processedDays++;
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

// Initialize worker
const worker = new Worker(QUEUE_NAME, processor, {
  connection,
  limiter: {
    max: 1, // Process 1 job at a time
    duration: 1000, // per second
  },
});

worker.on("ready", () => {
  console.log(
    `🚀 Worker connected and listening for jobs on queue: "${QUEUE_NAME}"`
  );
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err.message);
});

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed successfully`);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
