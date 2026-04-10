/**
 * GET /api/agents/priorities
 * Returns the current scored and ranked task list from the Engineering Manager.
 * Use ?refresh=1 to trigger a fresh orchestration pass.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { readEmBrief, runEmOrchestration } from "@/lib/agents/engineeringManager";
import { getCriticalTasks } from "@/lib/redis";

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";

  if (refresh) {
    const result = await runEmOrchestration();
    const criticalTasks = await getCriticalTasks().catch(() => []);
    const criticalEntries = criticalTasks.map((t) => ({
      taskId: t.id,
      title: `[CRITICAL] ${t.incidentCode}: ${t.symbol} — ${t.detail}`,
      priority: "CRITICAL" as const,
      source: "protection-integrity",
      createdAt: t.createdAt,
    }));
    return NextResponse.json({
      ok: true,
      fresh: true,
      critical: criticalEntries.length,
      criticalTasks: criticalEntries,
      selectedTaskId: result.selectedTaskId,
      selectedTaskTitle: result.selectedTaskTitle,
      strategistBias: result.strategist.marketBias,
      scoredTasks: result.scoredTasks,
    });
  }

  const brief = await readEmBrief().catch(() => null);
  if (!brief) {
    return NextResponse.json({ ok: true, fresh: false, scoredTasks: [], message: "No priorities computed yet. POST /api/agents/run to initialize." });
  }

  const criticalTasks = await getCriticalTasks().catch(() => []);
  const criticalEntries = criticalTasks.map((t) => ({
    taskId: t.id,
    title: `[CRITICAL] ${t.incidentCode}: ${t.symbol} — ${t.detail}`,
    priority: "CRITICAL" as const,
    source: "protection-integrity",
    createdAt: t.createdAt,
  }));

  return NextResponse.json({
    ok: true,
    fresh: false,
    id: brief.id,
    createdAt: brief.createdAt,
    selectedTaskId: brief.selectedTaskId,
    selectedTaskTitle: brief.selectedTaskTitle,
    strategistBias: brief.strategistBias,
    learningSignalsSummary: brief.learningSignalsSummary,
    critical: criticalEntries.length,
    criticalTasks: criticalEntries,
    scoredTasks: brief.scoredTasks,
  });
}
