//a simple file to create a bullmq queue instance for price history jobs, and export it for use in other files. 
import { Queue } from "bullmq";

export const QUEUE_NAME = "price-history-queue";

declare global { // reuse the same queue instance across hot reloads in dev mode, to avoid duplicate jobs and confusing state
  var _priceHistoryQueue: Queue | undefined;
}

const priceHistoryQueue = globalThis._priceHistoryQueue ?? new Queue(QUEUE_NAME, {
    connection: { // connect it to redis so that worker can acces this data directly from redis, instead of going through the API
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD,
    },
  });

globalThis._priceHistoryQueue = priceHistoryQueue;

export default priceHistoryQueue;
