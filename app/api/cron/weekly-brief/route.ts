import { NextRequest, NextResponse } from "next/server";
import { synthesizeWeeklyBrief } from "@/lib/agents/runner";
import { sendWeeklyBriefNotification } from "@/lib/notifications/weeklyBrief";
import { runCron } from "@/lib/agents/cronRun";

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
 * vercel.json (`crons`) to match the household's weekly review cadence. This
 * resynthesizes from whatever agent runs are already on hand (no agents are
 * re-run here) and sends the notification if one hasn't gone out today (see
 * the once-per-day dedup guard in lib/notifications/weeklyBrief.ts).
 *
 * Every invocation is recorded (ScanHealth "CRON:weekly-brief": a start row,
 * then ok / failed / skipped + reason). A brief that was NOT written is a
 * non-2xx response (422 skipped, 500 failed) — never a quiet 200.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runCron("weekly-brief", request, async () => {
    const brief = await synthesizeWeeklyBrief();
    if (brief.outcome === "skipped") {
      return { outcome: "skipped", reason: brief.reason, warnings: brief.warnings };
    }
    const notification = await sendWeeklyBriefNotification();
    return {
      outcome: "ok",
      warnings: brief.warnings,
      body: { brief: brief.outcome, weekOf: brief.weekOf, notification },
      metrics: { brief: brief.outcome, weekOf: brief.weekOf, notificationSent: notification.sent, notificationReason: notification.reason ?? null },
    };
  });
}
