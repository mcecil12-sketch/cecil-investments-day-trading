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

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const [strategist, emBrief] = await Promise.all([
    getStrategistBrief().catch(() => null),
    readEmBrief().catch(() => null),
  ]);

  return NextResponse.json({
    ok: true,
    strategist,
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
