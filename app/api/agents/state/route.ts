export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { ensureAgentState, listEngineeringTasks, readAgentStateSnapshot } from "@/lib/agents/store";
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

  const snapshot = await readAgentStateSnapshot();
  const state = await ensureAgentState();
  const tasks = (await listEngineeringTasks(200)).sort(
    (a, b) => executionVisibilityRank(a) - executionVisibilityRank(b),
  );

  const openTasks = tasks.filter(
    (task) =>
      task.status === "OPEN" ||
      task.status === "IN_PROGRESS" ||
      task.status === "READY_FOR_EXECUTION" ||
      task.status === "READY_FOR_PUSH",
  );
  const blockedTasks = tasks.filter((task) => task.status === "BLOCKED");
  const executionReadyTasks = tasks.filter(
    (task) => task.status === "READY_FOR_EXECUTION" || task.executionStatus === "READY",
  );
  const latestReadyForExecution = tasks
    .filter((task) => task.status === "READY_FOR_EXECUTION")
    .at(-1) ?? null;

  const derivedState = {
    ...state,
    openEngineeringTaskCount: openTasks.length + blockedTasks.length,
    openExecutionReadyCount: executionReadyTasks.length,
    blockedTaskCount: blockedTasks.length,
    latestExecutionTaskTitle: latestReadyForExecution?.title ?? null,
    latestExecutionStatus: latestReadyForExecution?.executionStatus ?? null,
  };

  return NextResponse.json({
    ok: true,
    state: derivedState,
    initialized: snapshot.source !== "stored",
  });
}