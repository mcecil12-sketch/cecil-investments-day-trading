export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import {
  runPatchExecution,
  runBuildAndTests,
  commitAndPush,
} from "@/lib/agents/execution/engine";
import { approveExecution } from "@/lib/agents/governance/manager";
import { listEngineeringTasks, updateEngineeringTaskById } from "@/lib/agents/store";
import type { EngineeringTask } from "@/lib/agents/types";

function appendNotes(current: string[] | undefined, additions: string[]): string[] {
  return [...(current ?? []), ...additions].filter(Boolean).slice(-20);
}

async function markExecutionFailure(task: EngineeringTask | null, message: string) {
  if (!task) return;

  await updateEngineeringTaskById(task.id, {
    remediationAttempted: true,
    remediationStatus: "failed",
    remediationResultSummary: message,
    notes: appendNotes(task.notes, [`Execution failed: ${message}`]),
  });
}

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  let task: EngineeringTask | null = null;

  try {
    const tasks = await listEngineeringTasks(100);
    task = tasks.find((candidate) => candidate.status === "OPEN") ?? null;

    if (!task) {
      return NextResponse.json({ ok: true, message: "No tasks to execute" });
    }

    const approval = approveExecution(task);

    if (!approval.ok) {
      const blockedNotes = appendNotes(task.notes, [`Execution blocked: ${approval.reason}`]);

      await updateEngineeringTaskById(task.id, {
        remediationAttempted: true,
        remediationStatus: "failed",
        remediationResultSummary: `Execution blocked: ${approval.reason}`,
        notes: blockedNotes,
      });

      return NextResponse.json(
        {
          ok: false,
          reason: approval.reason,
          taskId: task.id,
        },
        { status: 403 },
      );
    }

    const approvedNotes = appendNotes(task.notes, ["Execution approved by governance manager"]);

    await updateEngineeringTaskById(task.id, {
      status: "IN_PROGRESS",
      remediationAttempted: true,
      remediationStatus: "attempted",
      remediationResultSummary: "Execution approved; build and test gate started.",
      notes: approvedNotes,
    });

    task = {
      ...task,
      status: "IN_PROGRESS",
      remediationAttempted: true,
      remediationStatus: "attempted",
      remediationResultSummary: "Execution approved; build and test gate started.",
      notes: approvedNotes,
    };

    const patch = "";
    const apply = await runPatchExecution(patch);
    if (!apply.ok) {
      throw new Error(apply.error);
    }

    const test = await runBuildAndTests();
    if (!test.ok) {
      throw new Error(test.error);
    }

    const shouldCommit = patch.trim().length > 0;
    const commit = shouldCommit
      ? await commitAndPush(`agent: ${task.title}`)
      : { ok: true as const, skipped: true, reason: "safe_mode_no_patch" };

    if (!commit.ok) {
      throw new Error(commit.error);
    }

    const notes = appendNotes(task.notes, [
      apply.skipped ? `Patch skipped: ${apply.reason ?? "unspecified"}` : "Patch applied",
      "Build and tests passed",
      commit.skipped ? `Commit skipped: ${commit.reason ?? "unspecified"}` : "Commit pushed to main",
    ]);

    await updateEngineeringTaskById(task.id, {
      status: "DONE",
      remediationAttempted: true,
      remediationStatus: "succeeded",
      remediationResultSummary: commit.skipped
        ? "Safe mode execution completed. Build and tests passed; commit skipped."
        : "Execution completed. Patch applied, validation passed, and changes pushed to main.",
      notes,
    });

    return NextResponse.json({
      ok: true,
      executedTaskId: task.id,
      apply,
      test,
      commit,
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