import { NextRequest, NextResponse } from "next/server";
import { synthesizeWeeklyBrief } from "@/lib/agents/runner";
import { sendWeeklyBriefNotification } from "@/lib/notifications/weeklyBrief";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on scheduled invocations. If CRON_SECRET isn't configured (e.g. local dev), there's nothing to check against, so requests are allowed through. */
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Weekly brief resync + Pushover notification, scheduled Sunday evening via
 * vercel.json (`crons`) to match the household's weekly review cadence.
 * Previously sendWeeklyBriefNotification() only fired as a side effect of an
 * import or a manual Risk Manager run — on weeks with neither, no
 * notification went out at all. This resynthesizes from whatever agent runs
 * are already on hand (no agents are re-run here) and sends the
 * notification if one hasn't gone out today (see the once-per-day dedup
 * guard in lib/notifications/weeklyBrief.ts, which still applies in case an
 * import or manual run already sent one this week).
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await synthesizeWeeklyBrief();
  const result = await sendWeeklyBriefNotification();
  return NextResponse.json(result);
}
