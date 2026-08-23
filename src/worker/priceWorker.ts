// worker runs as a standalone script (not a Next.js page), so it needs its own dotenv load
import dotenv from "dotenv";
dotenv.config();

import { Worker } from "bullmq";
import { processor } from "./priceProcessor";
import { rateToIntervalMs } from "../lib/alchemyRateLimiter";
import redisClient from "../lib/redisConnect";

const QUEUE_NAME = "price-history-queue";

if (!process.env.ALCHEMY_API_KEY) {
  throw new Error("ALCHEMY_API_KEY is not defined in environment variables");
}

const connection = {
  host: process.env.REDIS_HOST,
  // Explicit fallback matching redisConnect.ts and priceHistoryQueue.ts -
  // this previously had none, silently relying on ioredis's own internal
  // default (also 6379, so not currently a live bug, but implicit and
  // inconsistent with how the other two connection points state it).
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  keepAlive: true,
};

// Alchemy's free tier caps at 300 token_price requests/hour - confirmed
// via the literal error text ("Your free app has exceeded its limit of
// 300 token_price requests per 1 hours"), not a guess. Defaults to that
// exact ceiling expressed as an exact fraction (300/3600 req/s) computed in
// code rather than a rounded decimal literal in .env, so the common
// (unset) case has no precision loss - override ALCHEMY_RPS in .env if
// you're on a paid tier with a higher limit.
const DEFAULT_ALCHEMY_RPS = 300 / 3600;
const alchemyRps = Number(process.env.ALCHEMY_RPS) || DEFAULT_ALCHEMY_RPS;
const alchemyRequestIntervalMs = rateToIntervalMs(alchemyRps);

const worker = new Worker(
  QUEUE_NAME,
  // Wrapped rather than passed directly - processor() needs the Redis
  // client and the computed pacing interval, which BullMQ's Processor type
  // doesn't have a slot for. See alchemyRateLimiter.ts for why this pacer
  // (not BullMQ's own queue-wide limiter) is what actually bounds Alchemy
  // traffic now: a job can make anywhere from zero to ~9-11 Alchemy calls
  // depending on the token's age and how much is already backfilled, so a
  // job-dispatch-rate limiter can't precisely bound the real thing that
  // matters (calls/second) once the calls-per-job ratio is variable -
  // sizing it for the worst case would throttle every job as if it always
  // needed the maximum. There is deliberately no `limiter` option here
  // anymore; WORKER_CONCURRENCY below is the only dispatch-side control,
  // and the Redis pacer inside fetchPriceRange is the only Alchemy-rate
  // control.
  (job) => processor(job, redisClient, alchemyRequestIntervalMs),
  {
    connection,
    // How many jobs THIS worker process runs at once. BullMQ handles
    // multiple consumers on one queue with no code beyond this - running N
    // worker processes (e.g. multiple `npm run worker` instances, or
    // multiple containers) multiplies job throughput further; concurrency
    // here only controls one process's share of it.
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 5,
  }
);

worker.on("ready", () => {
  console.log(
    `🚀 Worker connected and listening for jobs on queue: "${QUEUE_NAME}" (Alchemy pacing: 1 request per ${alchemyRequestIntervalMs}ms)`
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
