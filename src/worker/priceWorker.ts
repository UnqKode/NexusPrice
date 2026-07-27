// worker runs as a standalone script (not a Next.js page), so it needs its own dotenv load
import dotenv from "dotenv";
dotenv.config();

import { Worker } from "bullmq";
import { processor } from "./priceProcessor";

const QUEUE_NAME = "price-history-queue";

if (!process.env.ALCHEMY_API_KEY) {
  throw new Error("ALCHEMY_API_KEY is not defined in environment variables");
}

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  keepAlive: true,
};

const worker = new Worker(QUEUE_NAME, processor, {
  connection,
  limiter: {
    max: 1,
    duration: 1000,
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
