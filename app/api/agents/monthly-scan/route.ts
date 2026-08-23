import { NextResponse } from "next/server";
import { runAndPersistMonthlyScan } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

/** Manual/on-demand trigger for Group 3's monthly scan (see lib/agents/monthlyScan.ts), for testing and reruns from the Agents page — same pattern as /api/agents/candidates. Tagged triggerSource: "manual" so it never counts toward Group 3's trading-readiness banner, which only recognizes real "cron" cycles. */
export async function POST() {
  const result = await runAndPersistMonthlyScan("manual");
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
