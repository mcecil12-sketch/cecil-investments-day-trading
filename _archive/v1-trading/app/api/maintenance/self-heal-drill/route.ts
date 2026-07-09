/**
 * POST /api/maintenance/self-heal-drill
 *
 * Injects a synthetic CRITICAL incident task into Redis for end-to-end
 * self-heal loop validation. Token-gated like other maintenance routes.
 *
 * Body (optional):
 *   { title?: string, incidentCode?: string, symbol?: string }
 *
 * Returns the created critical task.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { saveCriticalTask, getCriticalTasks, partitionCriticalTasks } from "@/lib/redis";

const DEFAULT_DRILL_TTL_HOURS = 2;

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults are used
  }

  const incidentCode = String(body?.incidentCode || "SELF_HEAL_DRILL");
  const symbol = String(body?.symbol || "DRILL");
  const title = String(body?.title || `Synthetic self-heal drill: ${incidentCode} on ${symbol}`);
  const ttlHours = Number(body?.ttlHours ?? DEFAULT_DRILL_TTL_HOURS);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

  const task = await saveCriticalTask({
    incidentCode: incidentCode as any,
    symbol,
    severity: "CRITICAL",
    detail: title,
    synthetic: true,
    expiresAt,
    status: "open",
  });

  if (!task) {
    return NextResponse.json(
      { ok: false, error: "redis_unavailable", message: "Could not create drill task — Redis not configured" },
      { status: 503 },
    );
  }

  const allCritical = await getCriticalTasks().catch(() => []);
  const { blocking, synthetic } = partitionCriticalTasks(allCritical);

  return NextResponse.json({
    ok: true,
    drill: true,
    createdTask: task,
    totalUnresolvedCritical: allCritical.length,
    blockingCriticalCount: blocking.length,
    syntheticCriticalCount: synthetic.length,
    message: `Synthetic drill task created: ${task.id}. Expires at ${expiresAt}. Run /api/agents/execute to trigger self-heal bypass.`,
  });
}
