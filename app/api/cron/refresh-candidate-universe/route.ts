import { NextRequest, NextResponse } from "next/server";
import { runAndPersistCandidateUniverseRefresh } from "@/lib/agents/runner";

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
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runAndPersistCandidateUniverseRefresh();
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
