export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { prepareExecutionPlan } from "@/lib/agents/execution/engine";
import { executeGithubTask } from "@/lib/agents/githubExecutor";
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
  return (
    task.status === "OPEN" ||
    task.status === "READY_FOR_EXECUTION" ||
    task.status === "READY_FOR_PUSH"
  );
}

function executionSortRank(task: EngineeringTask): number {
  return task.status === "READY_FOR_EXECUTION"
    ? 0
    : task.status === "READY_FOR_PUSH"
      ? 10
      : task.status === "OPEN"
        ? 20
        : 100;
}

function validateExecutionGuardrails(task: EngineeringTask): string | null {
  if (task.patchPlan?.mode !== "GITHUB_COMMIT") {
    return "patch_mode_not_github_commit";
  }
  if (task.commitPlan?.pushDirect !== true) {
    return "push_direct_not_enabled";
  }
  if (!task.commitPlan?.commitMessage?.trim()) {
    return "missing_commit_message";
  }
  return null;
}

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  let task: EngineeringTask | null = null;

  try {
    const tasks = await listEngineeringTasks(100);
    task = tasks
      .filter((candidate) => isEligibleTask(candidate))
      .sort((a, b) => executionSortRank(a) - executionSortRank(b))[0] ?? null;

    if (!task) {
      return NextResponse.json({ ok: true, message: "No execution-ready tasks" });
    }

    if (task.status === "READY_FOR_EXECUTION" || task.status === "READY_FOR_PUSH") {
      const guardrailError = validateExecutionGuardrails(task);

      if (guardrailError) {
        const skippedNotes = appendNotes(task.notes, [`Execution skipped: ${guardrailError}`]);
        await updateEngineeringTaskById(task.id, {
          notes: skippedNotes,
          executionError: guardrailError,
        });

        return NextResponse.json({
          ok: true,
          taskId: task.id,
          executionStatus: task.executionStatus ?? "READY",
          skipped: true,
          reason: guardrailError,
        });
      }

      try {
        const executionResult = await executeGithubTask(task);

        await updateEngineeringTaskById(task.id, {
          status: "DONE",
          remediationAttempted: true,
          remediationStatus: "completed",
          remediationResultSummary: `Executed via GitHub executor (${executionResult.filesTouched.join(", ")}).`,
          executionStatus: "EXECUTED",
          executionError: null,
          notes: appendNotes(task.notes, [
            "Executed via GitHub executor",
            `Commit message: ${executionResult.commitMessage}`,
          ]),
        });

        return NextResponse.json({
          ok: true,
          executedTaskId: task.id,
          executionStatus: "EXECUTED",
          filesTouched: executionResult.filesTouched,
          commitMessage: executionResult.commitMessage,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updateEngineeringTaskById(task.id, {
          status: "BLOCKED",
          remediationAttempted: true,
          remediationStatus: "failed",
          remediationResultSummary: `Execution failed: ${message}`,
          executionStatus: "FAILED",
          executionError: message,
          notes: appendNotes(task.notes, [`Execution failed: ${message}`]),
        });

        return NextResponse.json(
          {
            ok: false,
            error: message,
            taskId: task.id,
            executionStatus: "FAILED",
          },
          { status: 500 },
        );
      }
    }

    const approval = task.status === "OPEN" ? approveExecution(task) : { ok: true as const };

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