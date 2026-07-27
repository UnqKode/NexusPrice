import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import { historyJobId } from "@/lib/jobId";
import priceHistoryQueue from "@/lib/priceHistoryQueue";

export async function POST(request: NextRequest) {
  try {
    await dbConnect();
    console.log("✅ Successfully connected to MongoDB.");
    const body = await request.json();
    const { coinId, network } = body;

    if (!coinId || !network) {
      return NextResponse.json(
        { success: false, message: "coinId and network are required" },
        { status: 400 }
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
    console.log(`✅ Job added to queue for ${coinId} on ${network}.`);

    return NextResponse.json({
      success: true,
      message: `History fetch for ${coinId} has been scheduled.`,
      jobId,
    });
  } catch (error: unknown) {
    let message = "Unknown error";

    if (error instanceof Error) {
      message = error.message;
      console.error("❌ Error in /api/schedule:", message);
    } else {
      console.error("❌ Error in /api/schedule:", error);
    }

    return NextResponse.json(
      { success: false, message: "Failed to schedule job.", error: message },
      { status: 500 }
    );
  }
}
