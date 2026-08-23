// Pure job-processing logic, deliberately separated from src/worker/priceWorker.ts
// (the entrypoint that instantiates a real BullMQ Worker). Importing *this*
// file has no side effects - no Redis connection, no queue consumption - so
// it can be imported directly in tests.
import { Job } from "bullmq";
import dbConnect from "../lib/dbConnect";
import Price from "../model/price.model";
import { toAlchemyNetwork } from "../lib/networks";
import { addUtcDays } from "../lib/dateRange";
import { waitForRateLimitSlot } from "../lib/alchemyRateLimiter";
import type { RedisLike } from "../lib/priceCache";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

// One global key, not per-token/network - the 300/hour token_price quota
// is scoped to the Alchemy API key itself, shared across every call
// regardless of which token is being fetched.
const ALCHEMY_TOKEN_PRICE_RATE_LIMIT_KEY = "alchemy:ratelimit:token_price";

// Alchemy's tokens/historical endpoint caps a 1-day-interval range at 365
// days / 365 points - confirmed empirically (730 and 1,095-day ranges are
// both rejected outright with "1d interval is limited to 365 days or 365
// total data points"). A 3-year-old token's backfill is therefore ~3 calls
// at this window size, not ~1,095 day-by-day calls - small enough that a
// single job looping over windows sequentially is the right design, not a
// coordinator fanning out into separate chunk jobs (see the Task 3 scope
// discussion: at this call count, one job finishes in single-digit
// seconds, and there's no completion time left to distribute across
// workers within one token's job).
const MAX_WINDOW_DAYS = 365;

// Not paced by ALCHEMY_TOKEN_PRICE_RATE_LIMIT_KEY - alchemy_getAssetTransfers
// is a Node RPC / Transfers API call, drawing from Alchemy's general
// compute-unit budget, not the same 300/hour token_price bucket
// fetchPriceRange consumes (confirmed empirically: this call succeeded
// cleanly immediately after a run that had exhausted the token_price
// limit). Pacing it at the same rate would be needlessly conservative for
// a quota it doesn't actually share.
export const findTokenBirthday = async (
  coinId: string,
  network: string
): Promise<Date> => {
  const alchemyNetwork = toAlchemyNetwork(network);
  const url = `https://${alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Below priceCache's lockTtlMs (10s default) - a hung Alchemy call
      // must fail before it could ever hold a single-flight lock for its
      // full duration (Task 8b).
      signal: AbortSignal.timeout(8_000),
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

// Distinguishes "Alchemy rate-limited this request" from any other failure
// - processor() lets this propagate (rather than swallowing it into an
// empty result the way other errors are), so the job fails and BullMQ's
// queue-level attempts/backoff (see historyJobId's call site in
// schedule/route.ts) retries it, instead of the old behavior of silently
// recording the whole window as "no data".
export class AlchemyRateLimitError extends Error {
  constructor(message: string, public readonly retryAfterMs: number | null) {
    super(message);
    this.name = "AlchemyRateLimitError";
  }
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  // Retry-After is either a number of seconds, or an HTTP-date - only the
  // numeric form is handled; an HTTP-date value falls back to null rather
  // than a fragile ad-hoc date parse.
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export interface HistoricalPricePoint {
  date: Date;
  price: number;
}

/**
 * Fetches up to MAX_WINDOW_DAYS of daily prices in a single Alchemy call,
 * replacing the old one-call-per-day loop. Returns one point per day
 * Alchemy actually had data for (may be fewer than the requested day
 * count - a gap is not an error).
 *
 * `redis` and `requestIntervalMs` pace this call against every other
 * fetchPriceRange call across every worker process (see
 * alchemyRateLimiter.ts) - required, not optional, so a caller can't
 * accidentally deploy without pacing and silently blow through the real
 * quota once a job can make a variable number of these calls.
 */
export const fetchPriceRange = async (
  coinId: string,
  network: string,
  startDate: Date,
  endDate: Date,
  redis: RedisLike,
  requestIntervalMs: number
): Promise<HistoricalPricePoint[]> => {
  await waitForRateLimitSlot(redis, ALCHEMY_TOKEN_PRICE_RATE_LIMIT_KEY, requestIntervalMs);

  const alchemyNetwork = toAlchemyNetwork(network);
  const url = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`;

  const body = {
    address: coinId,
    network: alchemyNetwork,
    startTime: startDate.toISOString(),
    endTime: endDate.toISOString(),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    throw new AlchemyRateLimitError(
      `Rate limited fetching price range for ${coinId} (${startDate.toISOString()} - ${endDate.toISOString()})`,
      parseRetryAfterMs(response.headers.get("Retry-After"))
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`🔴 Alchemy API error response:`, errorText);
    return [];
  }

  const data = await response.json();
  const points = data?.data;
  if (!Array.isArray(points)) return [];

  const result: HistoricalPricePoint[] = [];
  for (const point of points) {
    const price = point?.value !== undefined ? parseFloat(point.value) : NaN;
    const rawDate = point?.timestamp ? new Date(point.timestamp) : null;
    if (!rawDate || isNaN(rawDate.getTime()) || isNaN(price)) continue;

    // Normalised to UTC midnight to match how documents are stored/looked
    // up - Alchemy's daily points already come back at T00:00:00Z, but
    // this is a cheap defensive guarantee rather than an assumption.
    rawDate.setUTCHours(0, 0, 0, 0);
    result.push({ date: rawDate, price });
  }
  return result;
};

interface Window {
  start: Date;
  end: Date;
}

function splitIntoWindows(start: Date, end: Date, maxWindowDays: number): Window[] {
  const windows: Window[] = [];
  let windowStart = new Date(start);

  while (windowStart <= end) {
    const desiredEnd = addUtcDays(windowStart, maxWindowDays - 1);
    const windowEnd = desiredEnd > end ? end : desiredEnd;
    windows.push({ start: new Date(windowStart), end: new Date(windowEnd) });
    windowStart = addUtcDays(windowEnd, 1);
  }

  return windows;
}

// Pure in-memory Set lookups, not I/O - looping day-by-day here is cheap
// regardless of window size, unlike the old design where each "day" meant
// an Alchemy call. This just decides whether a window's Alchemy call can
// be skipped entirely because every day in it is already stored.
function isWindowFullyKnown(window: Window, existingDateKeys: Set<string>): boolean {
  let cursor = new Date(window.start);
  while (cursor <= window.end) {
    if (!existingDateKeys.has(cursor.toISOString())) return false;
    cursor = addUtcDays(cursor, 1);
  }
  return true;
}

export const processor = async (
  job: Job,
  redis: RedisLike,
  requestIntervalMs: number
): Promise<{ coinId: string; network: string; status: string }> => {
  const { coinId, network } = job.data;

  // Normalised once here rather than via a pre-save hook - the write below
  // is Model.updateOne(), and Mongoose document middleware (pre('save'))
  // never runs for query-based writes, so a hook would silently not apply
  // to this path. See the comment on the schema for the full reasoning.
  const normalizedCoinId = coinId.toLowerCase();
  const normalizedNetwork = network.toLowerCase();

  try {
    await dbConnect();

    // Deliberately not paced by the token bucket below (unlike
    // fetchPriceRange) - alchemy_getAssetTransfers draws from Alchemy's
    // general compute-unit budget, not the 300/hour token_price bucket
    // fetchPriceRange consumes. Confirmed empirically, not assumed: this
    // exact call succeeded cleanly immediately after a run that had
    // exhausted the token_price limit (a 429 with "exceeded your limit of
    // 300 token_price requests"), so pacing it against that budget would be
    // needlessly conservative for a quota it doesn't actually share.
    const birthday = await findTokenBirthday(coinId, network);

    const startDate = new Date(birthday.setUTCHours(0, 0, 0, 0));
    const today = new Date(new Date().setUTCHours(0, 0, 0, 0));

    // One query for the whole range instead of one findOne per day - keeps
    // a replay of this job from re-fetching already-known days.
    const existingDocs = await Price.find(
      { tokenAddress: normalizedCoinId, network: normalizedNetwork, date: { $gte: startDate, $lte: today } },
      { date: 1 }
    ).lean();
    const existingDateKeys = new Set(existingDocs.map((doc) => doc.date.toISOString()));

    const windows = splitIntoWindows(startDate, today, MAX_WINDOW_DAYS);

    let windowsProcessed = 0;
    let savedPrices = 0;

    for (const window of windows) {
      if (!isWindowFullyKnown(window, existingDateKeys)) {
        const points = await fetchPriceRange(coinId, network, window.start, window.end, redis, requestIntervalMs);

        for (const point of points) {
          const dateKey = point.date.toISOString();
          if (existingDateKeys.has(dateKey)) continue; // already stored, e.g. from a previous partial run of this same window

          // Upsert instead of findOne+create: with the unique index on
          // (tokenAddress, network, date) this is race-free even if another
          // process writes the same day concurrently. Empirically confirmed
          // against the real collection (20 concurrent upserts on the same
          // key, 0 errors, exactly 1 insert) that MongoDB's server-side
          // upsert-retry absorbs this race and no-ops the losing writers
          // rather than surfacing a duplicate-key error - but that's this
          // cluster's current behavior, not a documented cross-version
          // guarantee, and WORKER_CONCURRENCY>1 makes concurrent upserts
          // across different tokens' jobs routine. Catching E11000
          // explicitly costs nothing and removes the dependency on that
          // implicit behavior entirely: a duplicate key here means another
          // process already wrote this exact row, which is the successful
          // outcome we wanted anyway.
          try {
            await Price.updateOne(
              { tokenAddress: normalizedCoinId, network: normalizedNetwork, date: point.date },
              {
                $setOnInsert: {
                  tokenAddress: normalizedCoinId,
                  network: normalizedNetwork,
                  date: point.date,
                  price: point.price,
                },
              },
              { upsert: true }
            );
          } catch (err) {
            const isDuplicateKeyError = (err as { code?: number })?.code === 11000;
            if (!isDuplicateKeyError) {
              throw err;
            }
          }
          existingDateKeys.add(dateKey);
          savedPrices++;
        }
      }

      windowsProcessed++;
      // Reported once per window (at most MAX_WINDOW_DAYS=365 days each,
      // and a job now has single digits to low tens of windows total) -
      // replaces the old per-day progress reporting, which was thousands
      // of Redis writes per job for a progress bar.
      await job.updateProgress({
        windowsProcessed,
        totalWindows: windows.length,
        savedPrices,
        percent: Math.round((windowsProcessed / windows.length) * 100),
      });
    }

    console.log(
      `🎉 Finished processing ${coinId} on ${network}. Processed ${windowsProcessed} window(s), saved ${savedPrices} new prices.`
    );
    return { coinId, network, status: "Completed" };
  } catch (error) {
    console.error(`❌ Error processing job for ${coinId} on ${network}:`, error);
    throw error;
  }
};
