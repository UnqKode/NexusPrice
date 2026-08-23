import { NextRequest, NextResponse } from "next/server";
import priceHistoryQueue from "@/lib/priceHistoryQueue";
import { historyJobId } from "@/lib/jobId";
import redisClient from "@/lib/redisConnect";
import { guardRoute } from "@/lib/routeGuard";
import { isValidTokenAddress } from "@/lib/validation";
import { logger } from "@/lib/logger";

// Read-only and cheap (one BullMQ lookup, no Alchemy call) - not
// admin-gated, generous limit so polling this while a backfill runs isn't
// throttled.
// No failClosedOnRedisError here: this route never calls Alchemy (it's a
// single BullMQ status lookup), so there's no quota to protect - fail-open
// is fine, consistent with the rest of this codebase's Redis-optionality
// stance.
const RATE_LIMIT = { routeName: "schedule-status", limit: 120, windowSeconds: 60 };

// Surfaces what was previously invisible: "Schedule Full History" used to
// fire-and-forget with no way to tell if the job was queued, running,
// stuck, or had failed outright.
export async function GET(request: NextRequest) {
  const guard = await guardRoute(request, redisClient, RATE_LIMIT);
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const coinId = searchParams.get("coinId");
  const network = searchParams.get("network");

  if (!coinId || !network) {
    return NextResponse.json(
      { success: false, message: "coinId and network query params are required" },
      { status: 400, headers: guard.headers }
    );
  }

  if (!isValidTokenAddress(coinId)) {
    return NextResponse.json(
      { success: false, message: "coinId must be a valid token address (0x + 40 hex chars)" },
      { status: 400, headers: guard.headers }
    );
  }

  try {
    const jobId = historyJobId(coinId, network);
    const job = await priceHistoryQueue.getJob(jobId);

    if (!job) {
      return NextResponse.json(
        { success: true, found: false, jobId, state: "not_found" },
        { headers: guard.headers }
      );
    }

    const state = await job.getState();

    return NextResponse.json(
      {
        success: true,
        found: true,
        jobId,
        state, // "waiting" | "active" | "completed" | "failed" | "delayed" | ...
        progress: job.progress ?? null,
        result: job.returnvalue ?? null,
        failedReason: job.failedReason ?? null,
        attemptsMade: job.attemptsMade,
      },
      { headers: guard.headers }
    );
  } catch (error) {
    logger.error("❌ Error in /api/schedule/status:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch job status." },
      { status: 500, headers: guard.headers }
    );
  }
}
