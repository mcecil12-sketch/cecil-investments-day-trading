import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { runAndPersistCandidateUniverseRefresh, runAndPersistMonthlyScan } from "@/lib/agents/runner";
import { runMonthlyScanDryRun } from "@/lib/agents/monthlyScanDryRun";
import { isDryRun, runCron } from "@/lib/agents/cronRun";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

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
 *
 * The scan itself runs via waitUntil(), not a bare detached promise: Vercel
 * makes no guarantee that unawaited work continues after the response is
 * sent (the function's execution environment can be frozen/torn down the
 * moment the response flushes). waitUntil() is the documented primitive for
 * "keep this invocation alive for background work without blocking the
 * response" — it extends the invocation's own lifetime (up to maxDuration)
 * rather than blocking on the promise before responding.
 */
export async function GET(request: NextRequest) {
  const functionStartedAtMs = Date.now();
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // `?dryRun=1` proves the whole Nov 1 path (same auth, same route, same
  // runtime limit) without writing data: the universe refresh and the log
  // write are skipped, the monthly pipeline runs with real pacing, and the
  // timing/diagnostic report is returned in the response. The only rows
  // written are the cron's own start/finish ScanHealth rows (tagged dryRun).
  if (isDryRun(request)) {
    return runCron("refresh-candidate-universe", request, async () => {
      const report = await runMonthlyScanDryRun();
      return {
        outcome: "ok",
        body: { dryRun: true, universeRefresh: "skipped (dry run writes nothing)", report },
        metrics: { dryRun: true, totalMs: report.totalMs, percentOfMaxDuration: report.percentOfMaxDuration, ranked: report.counts.ranked },
      };
    });
  }

  return runCron("refresh-candidate-universe", request, async () => {
    const result = await runAndPersistCandidateUniverseRefresh();
    if (result.status === "FAILED") return { outcome: "failed", reason: result.error ?? "universe refresh failed", body: { ...result } };

    waitUntil(
      runAndPersistMonthlyScan("cron", { functionStartedAtMs }).catch((err) => {
        console.error("Post-universe-refresh monthly scan failed:", err);
      }),
    );
    return { outcome: "ok", body: { ...result } };
  });
}
