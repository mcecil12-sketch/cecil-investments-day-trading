export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import {
  createManualActionTask,
  listManualActionTasks,
  countOpenExecutionReadyManualTasks,
  findDuplicateManualTask,
  canRecoverBlockedTask,
  recoverBlockedTasksWithFallbackHints,
  computeTaskSelectability,
  type ManualActionStatus,
  type ManualActionTaskInput,
  type BlockedTaskRecoveryResult,
} from "@/lib/agents/manual-action-queue";
import { getCriticalTasks, partitionCriticalTasks } from "@/lib/redis";

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

  // ─── Step 1: Run blocked task recovery BEFORE reading counts ──────
  // This ensures recoverable BLOCKED tasks are promoted to OPEN so that
  // selectableCount reflects actually-available work.
  let recoveryResult: BlockedTaskRecoveryResult | null = null;
  try {
    recoveryResult = await recoverBlockedTasksWithFallbackHints(false);
    if (recoveryResult.recoveredCount > 0) {
      console.log(
        `[QUEUE-GET] Blocked task recovery: ${recoveryResult.recoveredCount} tasks unblocked, ` +
        `${recoveryResult.enrichedCount} enriched, recovered=[${recoveryResult.recoveredTaskIds}]`,
      );
    }
  } catch (err) {
    console.warn("[QUEUE-GET] Blocked task recovery failed (non-fatal):", err);
  }

  // ─── Step 2: Fetch both manual queue and critical tasks in parallel ─
  const [tasks, counts, criticalTasks] = await Promise.all([
    listManualActionTasks({
      status: status ?? undefined,
      executionReady,
      limit,
    }),
    countOpenExecutionReadyManualTasks(),
    getCriticalTasks().catch(() => []),
  ]);

  // Partition critical tasks
  const { blocking: blockingCritical, synthetic: syntheticCritical } = partitionCriticalTasks(criticalTasks);

  // Annotate tasks with selectability
  const annotatedTasks = tasks.map((t) => ({
    ...t,
    _selectability: computeTaskSelectability(t),
  }));

  // Build diagnostic summary
  const diagnostics = {
    manualQueue: {
      openCount: counts.openCount,
      executionReadyCount: counts.executionReadyCount,
      inProgressCount: counts.inProgressCount,
      blockedCount: counts.blockedCount,
      selectedCount: counts.selectedCount,
      selectableCount: counts.selectableCount,
      recoverableBlockedCount: counts.recoverableBlockedCount,
      idleReason: counts.idleReason,
    },
    criticalTasks: {
      total: criticalTasks.length,
      blocking: blockingCritical.length,
      synthetic: syntheticCritical.length,
    },
    // Summary: total execution-ready work available
    totalExecutionReady: counts.executionReadyCount + blockingCritical.length,
    // Explain why tasks might not be ready
    selectionExplanation:
      counts.selectableCount > 0
        ? "manual_queue_has_selectable_tasks"
        : blockingCritical.length > 0
          ? "critical_tasks_available_but_manual_queue_empty"
          : counts.recoverableBlockedCount > 0
            ? "blocked_tasks_can_be_recovered_with_fallback_hints"
            : counts.blockedCount > 0
              ? "manual_tasks_exist_but_blocked_no_recovery_available"
              : counts.openCount > 0
                ? "manual_tasks_exist_but_not_execution_ready"
                : "no_work_available",
    // Recovery applied this request
    recoveryApplied: recoveryResult ? {
      attempted: recoveryResult.attempted,
      recoveredCount: recoveryResult.recoveredCount,
      enrichedCount: recoveryResult.enrichedCount,
      recoveredTaskIds: recoveryResult.recoveredTaskIds,
      fallbackHintsApplied: recoveryResult.enrichedCount > 0,
    } : null,
  };

  return NextResponse.json({
    ok: true,
    tasks: annotatedTasks,
    counts,
    criticalTaskCounts: diagnostics.criticalTasks,
    diagnostics,
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

  // Duplicate protection: check for existing OPEN/SELECTED/IN_PROGRESS task with same title+taskType
  const url = new URL(req.url);
  const forceDuplicate = url.searchParams.get("force") === "1";
  if (!forceDuplicate) {
    const duplicate = await findDuplicateManualTask(body.title, body.taskType);
    if (duplicate) {
      return NextResponse.json(
        {
          ok: false,
          error: "Duplicate task already exists in active state",
          duplicateTaskId: duplicate.id,
          duplicateStatus: duplicate.status,
          duplicateTitle: duplicate.title,
          hint: "Add ?force=1 to create anyway",
        },
        { status: 409 },
      );
    }
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
