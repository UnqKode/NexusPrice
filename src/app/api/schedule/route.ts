import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import { historyJobId } from "@/lib/jobId";
import priceHistoryQueue from "@/lib/priceHistoryQueue";
import redisClient from "@/lib/redisConnect";
import { guardRoute } from "@/lib/routeGuard";
import { isValidTokenAddress } from "@/lib/validation";
import { logger } from "@/lib/logger";

// Admin-only (triggers a real backfill, which spends Alchemy quota) and
// tightly limited - deterministic jobIds already make a duplicate
// submission a no-op, so this is about bounding distinct scheduling
// requests, not duplicate-job protection.
// failClosedOnRedisError: scheduling spends Alchemy quota too (a full
// backfill), same reasoning as price/historical-prices - a Redis outage
// shouldn't silently remove the one thing bounding how many backfills get
// triggered. (In practice priceHistoryQueue.add() would likely also fail
// during a real Redis outage since BullMQ needs Redis - this is about not
// relying on that as the only backstop.)
const RATE_LIMIT = {
  routeName: "schedule",
  limit: 10,
  windowSeconds: 3600,
  requireAdmin: true,
  failClosedOnRedisError: true,
};

export async function POST(request: NextRequest) {
  try {
    const guard = await guardRoute(request, redisClient, RATE_LIMIT);
    if (!guard.ok) return guard.response;

    await dbConnect();
    logger.debug("✅ Successfully connected to MongoDB.");
    const body = await request.json();
    const { coinId, network } = body;

    if (!coinId || !network) {
      return NextResponse.json(
        { success: false, message: "coinId and network are required" },
        { status: 400, headers: guard.headers }
      );
    }

    if (!isValidTokenAddress(coinId)) {
      return NextResponse.json(
        { success: false, message: "coinId must be a valid token address (0x + 40 hex chars)" },
        { status: 400, headers: guard.headers }
      );
    }

    const jobId = historyJobId(coinId, network);
    await priceHistoryQueue.add(
      "fetch-history",
      { coinId, network },
      {
        jobId, // re-scheduling the same token/network while a job is pending/active is a no-op
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      }
    );
    logger.info(`✅ Job added to queue for ${coinId} on ${network}.`);

    return NextResponse.json(
      {
        success: true,
        message: `History fetch for ${coinId} has been scheduled.`,
        jobId,
      },
      { headers: guard.headers }
    );
  } catch (error: unknown) {
    let message = "Unknown error";

    if (error instanceof Error) {
      message = error.message;
      logger.error("❌ Error in /api/schedule:", message);
    } else {
      logger.error("❌ Error in /api/schedule:", error);
    }

    return NextResponse.json(
      { success: false, message: "Failed to schedule job.", error: message },
      { status: 500 }
    );
  }
}
