import { NextRequest, NextResponse } from "next/server";
import priceHistoryQueue from "@/lib/priceHistoryQueue";
import { historyJobId } from "@/lib/jobId";

// Surfaces what was previously invisible: "Schedule Full History" used to
// fire-and-forget with no way to tell if the job was queued, running,
// stuck, or had failed outright.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const coinId = searchParams.get("coinId");
  const network = searchParams.get("network");

  if (!coinId || !network) {
    return NextResponse.json(
      { success: false, message: "coinId and network query params are required" },
      { status: 400 }
    );
  }

  try {
    const jobId = historyJobId(coinId, network);
    const job = await priceHistoryQueue.getJob(jobId);

    if (!job) {
      return NextResponse.json({ success: true, found: false, jobId, state: "not_found" });
    }

    const state = await job.getState();

    return NextResponse.json({
      success: true,
      found: true,
      jobId,
      state, // "waiting" | "active" | "completed" | "failed" | "delayed" | ...
      progress: job.progress ?? null,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
    });
  } catch (error) {
    console.error("❌ Error in /api/schedule/status:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch job status." },
      { status: 500 }
    );
  }
}
