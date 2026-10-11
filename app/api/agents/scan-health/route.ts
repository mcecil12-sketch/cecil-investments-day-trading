import { NextResponse } from "next/server";
import { getLatestScanHealth } from "@/lib/agents/scanHealth";

export const dynamic = "force-dynamic";

/** Latest health verdict per scan kind (monthly scan, weekly scan, weekly brief). Behind the app-wide PIN gate. */
export async function GET() {
  try {
    return NextResponse.json({ results: await getLatestScanHealth() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
