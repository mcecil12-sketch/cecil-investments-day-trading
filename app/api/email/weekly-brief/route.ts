import { NextResponse } from "next/server";
import { sendWeeklyBriefEmail } from "@/lib/email/weeklyBrief";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await sendWeeklyBriefEmail();
  if (!result.sent) {
    const status = result.reason?.includes("not configured")
      ? 400
      : result.reason?.includes("No weekly brief")
        ? 404
        : 502;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
