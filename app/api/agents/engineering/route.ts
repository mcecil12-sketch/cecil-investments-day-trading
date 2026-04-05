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

  const tasks = (await listEngineeringTasks(limit)).sort(
    (a, b) => executionVisibilityRank(a) - executionVisibilityRank(b),
  );
  const openTasks = tasks.filter(
    (task) =>
      task.status === "OPEN" ||
      task.status === "IN_PROGRESS" ||
      task.status === "READY_FOR_EXECUTION" ||
      task.status === "READY_FOR_PUSH" ||
      task.status === "READY_FOR_REVIEW",
  );
  const executionReadyTasks = tasks.filter(
    (task) => task.status === "READY_FOR_EXECUTION" || task.status === "READY_FOR_PUSH",
  );
  const blockedTasks = tasks.filter((task) => task.status === "BLOCKED" || task.executionStatus === "BLOCKED");
  const latestExecutionTask = tasks.find(
    (task) =>
      task.status === "READY_FOR_EXECUTION" ||
      task.status === "READY_FOR_PUSH" ||
      task.status === "OPEN" ||
      task.status === "IN_PROGRESS" ||
      task.status === "BLOCKED",
  );

  return NextResponse.json({
    ok: true,
    tasks,
    openTasks,
    executionReadyTasks,
    blockedTasks,
    openExecutionReadyCount: executionReadyTasks.length,
    blockedTaskCount: blockedTasks.length,
    latestExecutionTaskTitle: latestExecutionTask?.title ?? null,
    latestExecutionStatus: latestExecutionTask?.status ?? null,
  });
}