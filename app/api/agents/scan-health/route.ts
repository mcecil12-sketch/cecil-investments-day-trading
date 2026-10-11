import { NextResponse } from "next/server";
import { getLatestScanHealth } from "@/lib/agents/scanHealth";
import { getRecentCronRuns, summarizeCronRuns } from "@/lib/agents/cronRun";

export const dynamic = "force-dynamic";

/** Latest health verdict per scan kind (monthly scan, weekly scan, weekly brief). Behind the app-wide PIN gate. */
export async function GET() {
  try {
    const [results, cronRows] = await Promise.all([getLatestScanHealth(), getRecentCronRuns(40)]);
    return NextResponse.json({ results, cronLatest: summarizeCronRuns(cronRows), cronRecent: cronRows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
