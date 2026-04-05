export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listEngineeringTasks } from "@/lib/agents/store";

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, Math.floor(limitParam)) : 25;

  const tasks = await listEngineeringTasks(limit);
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

  return NextResponse.json({
    ok: true,
    tasks,
    openTasks,
    executionReadyTasks,
    blockedTasks,
  });
}