import { NextRequest, NextResponse } from "next/server";
import { runAndPersistMonthlyScan } from "@/lib/agents/runner";
import { runMonthlyScanDryRun } from "@/lib/agents/monthlyScanDryRun";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * Manual/on-demand trigger for Group 3's monthly scan (see lib/agents/monthlyScan.ts), for testing and reruns from the Agents page — same pattern as /api/agents/candidates. Tagged triggerSource: "manual" so it never counts toward Group 3's trading-readiness banner, which only recognizes real "cron" cycles.
 *
 * `?dryRun=1` runs the full pipeline (prices, fragility, paced insider pass) but persists nothing at all and returns a timing/diagnostic report instead.
 */
export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  if (request.nextUrl.searchParams.get("dryRun") === "1") {
    try {
      return NextResponse.json(await runMonthlyScanDryRun());
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  const result = await runAndPersistMonthlyScan("manual", { functionStartedAtMs: startedAtMs });
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
