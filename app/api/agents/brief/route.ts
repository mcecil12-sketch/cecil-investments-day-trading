/**
 * GET /api/agents/brief
 * Returns the current News/Policy Strategist brief and Engineering Manager
 * brief summary. Useful for inspecting what the agent system currently believes.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { getStrategistBrief } from "@/lib/agents/newsStrategist";
import { readEmBrief } from "@/lib/agents/engineeringManager";
import { getCriticalTasks } from "@/lib/redis";

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const [strategist, emBrief, criticalTasks] = await Promise.all([
    getStrategistBrief().catch(() => null),
    readEmBrief().catch(() => null),
    getCriticalTasks().catch(() => []),
  ]);

  const criticalCount = criticalTasks.length;
  const selfHealPending = criticalCount > 0;
  const criticalIncidentSummary = {
    criticalCount,
    selfHealPending,
    topCriticalTasks: criticalTasks.slice(0, 5).map((t) => ({
      id: t.id,
      incidentCode: t.incidentCode,
      symbol: t.symbol,
      detail: t.detail,
      createdAt: t.createdAt,
    })),
  };

  return NextResponse.json({
    ok: true,
    strategist,
    criticalIncidentSummary,
    emBrief: emBrief
      ? {
          id: emBrief.id,
          createdAt: emBrief.createdAt,
          selectedTaskTitle: emBrief.selectedTaskTitle,
          strategistBias: emBrief.strategistBias,
          learningSignalsSummary: emBrief.learningSignalsSummary,
          rationale: emBrief.rationale,
          topTasks: emBrief.scoredTasks.slice(0, 5).map((t) => ({
            title: t.title,
            priorityBucket: t.priorityBucket,
            priorityScore: t.priorityScore,
          })),
        }
      : null,
  });
}
