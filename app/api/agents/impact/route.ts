/**
 * GET /api/agents/impact
 * Returns recent execution impact records showing whether agent changes
 * improved trading outcomes.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listImpactRecords } from "@/lib/agents/executionImpact";

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "25"), 100);
  const records = await listImpactRecords(limit);

  const summary = {
    total: records.length,
    improved: records.filter((r) => r.impactStatus === "IMPROVED").length,
    neutral: records.filter((r) => r.impactStatus === "NEUTRAL").length,
    degraded: records.filter((r) => r.impactStatus === "DEGRADED").length,
    inconclusive: records.filter((r) => r.impactStatus === "INCONCLUSIVE").length,
  };

  return NextResponse.json({ ok: true, summary, records });
}
