import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on scheduled invocations. If CRON_SECRET isn't configured (e.g. local dev), there's nothing to check against, so requests are allowed through. */
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Fires 2 minutes ahead of the earnings-estimates cron (21:58 UTC, same
 * weekday schedule) to touch the DB and keep Neon's compute awake, so the
 * 22:00 cron connects to an already-warm endpoint instead of triggering a
 * cold start. Neon's autosuspend kicks in after 5 minutes idle, so a 2-minute
 * gap is comfortable margin. Not an AgentRun — this is infra upkeep, not a
 * data refresh, so it doesn't get an audit trail row. withColdStartRetry
 * isn't used here deliberately: if this ping itself hits a cold start, that's
 * fine, it's best-effort warmup, and the real cron still has its own retry
 * logic as a fallback.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "OK" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("db-keepalive: ping failed (best-effort, no retry):", message);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}
