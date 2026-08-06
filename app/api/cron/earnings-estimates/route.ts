import { NextRequest, NextResponse } from "next/server";
import { runAndPersistEarningsHistoryRefresh } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on scheduled invocations. If CRON_SECRET isn't configured (e.g. local dev), there's nothing to check against, so requests are allowed through. */
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Daily earnings-history refresh, scheduled via vercel.json (`crons`). Pulls
 * Alpha Vantage EARNINGS for today's batch of stale candidate universe
 * symbols (20/day quota — see DAILY_FETCH_QUOTA in earningsHistory.ts) and
 * upserts EarningsHistory + EarningsFetchState — see
 * lib/agents/earningsHistory.ts. Route path kept as /earnings-estimates
 * (not renamed) to avoid re-registering the Vercel cron schedule entry for
 * what's otherwise an internal data-source swap.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runAndPersistEarningsHistoryRefresh();
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
