import { NextRequest, NextResponse } from "next/server";
import { runAndPersistCandidateUniverseRefresh, runAndPersistMonthlyScan } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on scheduled invocations. If CRON_SECRET isn't configured (e.g. local dev), there's nothing to check against, so requests are allowed through. */
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Monthly candidate-universe refresh, scheduled via vercel.json (`crons`).
 * Pulls fresh SPDR sector holdings from SSGA for the dynamic sectors and
 * updates CandidateUniverse — see lib/agents/candidateUniverse.ts.
 *
 * Also triggers Group 3's monthly scan (see lib/agents/monthlyScan.ts) right
 * after a successful refresh — "No new Vercel cron jobs on Hobby" (see
 * docs/CRON_GUARDRAILS.md) rules out giving Group 3 its own cron entry, so
 * it piggybacks on this exact scheduled invocation instead, scanning against
 * the universe immediately after it's freshly refreshed. Only runs on a
 * successful universe refresh — scoring against a stale/broken universe
 * isn't worth the risk. Never blocks or fails this route's own response:
 * runAndPersistMonthlyScan creates and independently completes/fails its own
 * AgentRun row, so a MONTHLY_SCAN failure is visible on the Agents status
 * page regardless, without needing to be reflected in this JSON response.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runAndPersistCandidateUniverseRefresh();
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }

  runAndPersistMonthlyScan("cron").catch((err) => {
    console.error("Post-universe-refresh monthly scan failed:", err);
  });

  return NextResponse.json(result);
}
