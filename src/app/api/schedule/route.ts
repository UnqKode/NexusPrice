import { NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq"; // Import the Queue class
import dbConnect from "@/lib/dbConnect";

const QUEUE_NAME = "price-history-queue";

const priceHistoryQueue = new Queue(QUEUE_NAME, {
  connection: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || "15878"),
    password: process.env.REDIS_PASSWORD,
  },
});

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

    // --- FIX: This is where you add the job to the queue ---
    await priceHistoryQueue.add("fetch-history", { coinId, network });
    console.log(`✅ Job added to queue for ${coinId} on ${network}.`);

    return NextResponse.json({
      success: true,
      message: `History fetch for ${coinId} has been scheduled.`,
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
