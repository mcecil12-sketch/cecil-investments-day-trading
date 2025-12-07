import { NextResponse } from "next/server";
import { getRecentActivity } from "@/lib/activity";

export async function GET() {
  try {
    const entries = await getRecentActivity(200);
    return NextResponse.json({ entries }, { status: 200 });
  } catch (err) {
    console.error("GET /api/activity error:", err);
    return NextResponse.json(
      { error: "Failed to load activity" },
      { status: 500 }
    );
  }
}
