import { NextRequest, NextResponse } from "next/server";
import { runAndPersistSentimentRefresh } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on scheduled invocations. If CRON_SECRET isn't configured (e.g. local dev), there's nothing to check against, so requests are allowed through. */
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Daily news-sentiment refresh, scheduled via vercel.json (`crons`). Pulls
 * Alpha Vantage NEWS_SENTIMENT for today's batch of stale candidate universe
 * symbols (20/day quota — see DAILY_FETCH_QUOTA in newsSentimentScore.ts) and
 * upserts SentimentFetchState — see lib/agents/newsSentimentScore.ts. This
 * factor is scored and logged for validation only; it is NOT wired into the
 * composite score yet (see the dated note in scoringShared.ts).
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runAndPersistSentimentRefresh();
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
