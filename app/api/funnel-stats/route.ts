import { NextResponse } from "next/server";
import { readTodayFunnel } from "@/lib/funnelMetrics";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET() {
  const today = readTodayFunnel();
  return NextResponse.json(
    {
      today,
      timestamp: new Date().toISOString(),
    },
    { headers: CACHE_HEADERS }
  );
}
