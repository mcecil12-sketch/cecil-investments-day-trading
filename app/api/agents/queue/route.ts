export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import {
  createManualActionTask,
  listManualActionTasks,
  countOpenExecutionReadyManualTasks,
  type ManualActionStatus,
  type ManualActionTaskInput,
} from "@/lib/agents/manual-action-queue";

export async function GET(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const url = new URL(req.url);
  const status = url.searchParams.get("status") as ManualActionStatus | null;
  const executionReady = url.searchParams.has("executionReady")
    ? url.searchParams.get("executionReady") === "true"
    : undefined;
  const limit = url.searchParams.has("limit")
    ? Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50))
    : 50;

  const [tasks, counts] = await Promise.all([
    listManualActionTasks({
      status: status ?? undefined,
      executionReady,
      limit,
    }),
    countOpenExecutionReadyManualTasks(),
  ]);

  return NextResponse.json({
    ok: true,
    tasks,
    counts,
  });
}

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  let body: ManualActionTaskInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.title || !body.description || !body.priority || !body.taskType) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: title, description, priority, taskType" },
      { status: 400 },
    );
  }

  const validPriorities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  if (!validPriorities.includes(body.priority)) {
    return NextResponse.json(
      { ok: false, error: `Invalid priority. Must be one of: ${validPriorities.join(", ")}` },
      { status: 400 },
    );
  }

  const validTypes = [
    "BUGFIX", "BACKLOG", "OPTIMIZATION", "SELF_HEAL", "OPS",
    "SCORING", "SCANNER", "AUTO_ENTRY", "OTHER",
  ];
  if (!validTypes.includes(body.taskType)) {
    return NextResponse.json(
      { ok: false, error: `Invalid taskType. Must be one of: ${validTypes.join(", ")}` },
      { status: 400 },
    );
  }

  const task = await createManualActionTask(body);
  if (!task) {
    return NextResponse.json(
      { ok: false, error: "Failed to create task (Redis unavailable)" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, task }, { status: 201 });
}
