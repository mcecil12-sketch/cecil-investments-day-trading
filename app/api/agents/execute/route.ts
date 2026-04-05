export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { prepareExecutionPlan } from "@/lib/agents/execution/engine";
import { approveExecution } from "@/lib/agents/governance/manager";
import { listEngineeringTasks, updateEngineeringTaskById } from "@/lib/agents/store";
import type { EngineeringTask } from "@/lib/agents/types";

function appendNotes(current: string[] | undefined, additions: string[]): string[] {
  return [...(current ?? []), ...additions].filter(Boolean).slice(-20);
}

async function markExecutionFailure(task: EngineeringTask | null, message: string) {
  if (!task) return;

  await updateEngineeringTaskById(task.id, {
    status: task.status === "DONE" ? "DONE" : "FAILED",
    remediationAttempted: true,
    remediationStatus: "failed",
    remediationResultSummary: message,
    executionStatus: "FAILED",
    executionError: message,
    notes: appendNotes(task.notes, [`Execution failed: ${message}`]),
  });
}

function isEligibleTask(task: EngineeringTask): boolean {
  return task.status === "OPEN" || task.status === "IN_PROGRESS";
}

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  let task: EngineeringTask | null = null;

  try {
    const tasks = await listEngineeringTasks(100);
    task = tasks.find((candidate) => isEligibleTask(candidate)) ?? null;

    if (!task) {
      return NextResponse.json({ ok: true, message: "No tasks to execute" });
    }

    const approval = approveExecution(task);

    if (!approval.ok) {
      const blockedNotes = appendNotes(task.notes, [`Execution blocked: ${approval.reason}`]);

      await updateEngineeringTaskById(task.id, {
        status: "BLOCKED",
        remediationAttempted: true,
        remediationStatus: "failed",
        remediationResultSummary: `Execution blocked: ${approval.reason}`,
        executionStatus: "BLOCKED",
        executionError: approval.reason,
        notes: blockedNotes,
      });

      return NextResponse.json(
        {
          ok: false,
          reason: approval.reason,
          taskId: task.id,
          executionStatus: "BLOCKED",
        },
        { status: 403 },
      );
    }

    const prepared = prepareExecutionPlan(task);
    const approvedNotes = appendNotes(task.notes, [
      "Execution approved by governance manager",
      `Execution plan prepared for ${prepared.nextTaskStatus}`,
    ]);

    await updateEngineeringTaskById(task.id, {
      status: prepared.nextTaskStatus,
      remediationAttempted: true,
      remediationStatus: "attempted",
      remediationResultSummary: "Execution plan prepared and queued for external executor.",
      patchPlan: prepared.patchPlan,
      validationPlan: prepared.validationPlan,
      commitPlan: prepared.commitPlan,
      executionStatus: prepared.executionStatus,
      executionError: null,
      notes: approvedNotes,
    });

    return NextResponse.json({
      ok: true,
      taskId: task.id,
      executionStatus: prepared.nextTaskStatus,
      patchPlan: prepared.patchPlan,
      validationPlan: prepared.validationPlan,
      commitPlan: prepared.commitPlan,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markExecutionFailure(task, message);

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 },
    );
  }
}