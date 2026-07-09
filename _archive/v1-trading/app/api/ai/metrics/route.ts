import { NextResponse } from "next/server";
import { getAiBudget, getAiMetrics, aiMetricsKeyToday } from "@/lib/aiMetrics";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET() {
  const budget = await getAiBudget();
  const metrics = await getAiMetrics();
  const dbg = aiMetricsKeyToday();
  return NextResponse.json(
    {
      budget,
      metrics,
      debug: {
        storageKey: dbg.key,
        storageDate: dbg.date,
        fetchedAt: new Date().toISOString(),
      },
    },
    { headers: CACHE_HEADERS }
  );
}
