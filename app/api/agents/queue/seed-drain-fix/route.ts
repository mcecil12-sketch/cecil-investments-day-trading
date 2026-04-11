export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { createManualActionTask } from "@/lib/agents/manual-action-queue";

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const task = await createManualActionTask({
    title: "Fix scoring drain backlog",
    description:
      "Diagnose and fix persistent scoring drain throughput imbalance and pending backlog.",
    priority: "CRITICAL",
    taskType: "SCORING",
    executionReady: true,
    acceptanceCriteria: [
      "recent pending backlog materially reduced",
      "/api/ai/score/drain succeeds reliably",
      "scoring throughput improves",
      "smoke tests pass",
    ],
    routeHints: [
      "/api/ai/score/drain",
      "/api/signals/all",
      "/api/readiness",
    ],
    fileHints: [
      "app/api/ai/score/drain/route.ts",
      "app/api/signals/all/route.ts",
    ],
    createdBy: "seed-drain-fix",
  });

  if (!task) {
    return NextResponse.json(
      { ok: false, error: "Failed to create seed task (Redis unavailable)" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, task, message: "Drain fix task seeded into manual queue" }, { status: 201 });
}
