import { NextResponse } from "next/server";
import { readTodayAiMetrics } from "@/lib/aiMetrics";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET() {
  const { budget, metrics } = await readTodayAiMetrics();

  return NextResponse.json(
    {
      budget,
      metrics,
      timestamp: new Date().toISOString(),
    },
    { headers: CACHE_HEADERS }
  );
}
