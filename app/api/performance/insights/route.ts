/**
 * GET /api/performance/insights
 * Returns computed performance learning signals derived from recent closed trades.
 * Use ?refresh=1 to recompute from current trade data.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { computePerformanceLearning, readPerformanceLearning } from "@/lib/agents/performanceLearning";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";

  if (refresh) {
    const signals = await computePerformanceLearning();
    return NextResponse.json({ ok: true, fresh: true, insights: signals });
  }

  const stored = await readPerformanceLearning();
  if (!stored) {
    const signals = await computePerformanceLearning();
    return NextResponse.json({ ok: true, fresh: true, insights: signals });
  }

  return NextResponse.json({ ok: true, fresh: false, insights: stored });
}
