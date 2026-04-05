export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listEngineeringTasks } from "@/lib/agents/store";
import type { EngineeringTask } from "@/lib/agents/types";

function executionVisibilityRank(task: EngineeringTask): number {
  const incidentRank = task.incidentId ? 0 : 100;
  const statusRank =
    task.status === "READY_FOR_EXECUTION"
      ? 0
      : task.status === "READY_FOR_PUSH"
        ? 10
        : task.status === "OPEN"
          ? 20
          : task.status === "IN_PROGRESS"
            ? 20
            : task.status === "BLOCKED"
              ? 30
              : 100;
  return incidentRank + statusRank;
}

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, Math.floor(limitParam)) : 25;

  const allTasks = (await listEngineeringTasks(200)).sort(
    (a, b) => executionVisibilityRank(a) - executionVisibilityRank(b),
  );
  const tasks = allTasks.slice(0, limit);
  const openTasks = allTasks.filter(
    (task) =>
      task.status === "OPEN" ||
      task.status === "IN_PROGRESS" ||
      task.status === "READY_FOR_EXECUTION" ||
      task.status === "READY_FOR_PUSH",
  );
  const executionReadyTasks = allTasks.filter(
    (task) => task.status === "READY_FOR_EXECUTION" || task.executionStatus === "READY",
  );
  const blockedTasks = allTasks.filter((task) => task.status === "BLOCKED");
  const latestReadyForExecution = allTasks
    .filter((task) => task.status === "READY_FOR_EXECUTION")
    .at(-1) ?? null;

  return NextResponse.json({
    ok: true,
    tasks,
    openTasks,
    executionReadyTasks,
    blockedTasks,
    openEngineeringTaskCount: openTasks.length + blockedTasks.length,
    openExecutionReadyCount: executionReadyTasks.length,
    blockedTaskCount: blockedTasks.length,
    latestExecutionTaskTitle: latestReadyForExecution?.title ?? null,
    latestExecutionStatus: latestReadyForExecution?.executionStatus ?? null,
  });
}