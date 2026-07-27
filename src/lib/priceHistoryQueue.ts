import { Queue } from "bullmq";

export const QUEUE_NAME = "price-history-queue";

declare global {
  var _priceHistoryQueue: Queue | undefined;
}

// Reused across route modules (schedule + status) so a hot-reloaded dev
// server doesn't open a fresh Redis connection per import, same pattern as
// the existing redisConnect.ts singleton.
const priceHistoryQueue =
  globalThis._priceHistoryQueue ??
  new Queue(QUEUE_NAME, {
    connection: {
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || "15878"),
      password: process.env.REDIS_PASSWORD,
    },
  });

globalThis._priceHistoryQueue = priceHistoryQueue;

export default priceHistoryQueue;
