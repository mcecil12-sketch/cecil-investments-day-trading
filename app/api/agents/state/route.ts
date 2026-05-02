export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { ensureAgentState, listEngineeringTasks, readAgentStateSnapshot } from "@/lib/agents/store";
import {
  readAdaptiveGuardrailState,
  getActiveActions,
  getEffectiveMaxOpenPositions,
  getEffectiveMaxEntriesPerDay,
  getEffectiveMinScoreAdjustment,
  getEffectiveCooldownAfterLoss,
  getSuppressedSides,
} from "@/lib/agents/adaptiveGuardrails";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { checkGitHubWriteCapability } from "@/lib/agents/github-write";
import { redis } from "@/lib/redis";
import { AGENT_LATEST_EXECUTION_KEY, AGENT_LATEST_BATCH_EXECUTION_KEY } from "@/lib/agents/keys";
import type { EngineeringTask } from "@/lib/agents/types";
import { listManualActionTasks, countOpenExecutionReadyManualTasks, getActiveManualTask, getTrulyActiveManualTask, getNextQueuedManualTask, getManualQueueDiagnostics } from "@/lib/agents/manual-action-queue";

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

  const [snapshot, state, tasks, adaptiveState, latestExecRaw, latestBatchRaw, manualTasks, manualCounts, activeManualTask, trulyActiveTask, nextQueuedTask, queueDiagnostics] = await Promise.all([
    readAgentStateSnapshot(),
    ensureAgentState(),
    listEngineeringTasks(200).then((t) =>
      t.sort((a, b) => executionVisibilityRank(a) - executionVisibilityRank(b)),
    ),
    readAdaptiveGuardrailState().catch(() => ({ actions: [], lastEvaluatedAt: null, evaluationSource: null })),
    redis ? redis.get<string>(AGENT_LATEST_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
    redis ? redis.get<string>(AGENT_LATEST_BATCH_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
    listManualActionTasks({ limit: 10 }).catch(() => []),
    countOpenExecutionReadyManualTasks().catch(() => ({ openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0, selectedCount: 0, selectableCount: 0, recoverableBlockedCount: 0, idleReason: "count_fetch_failed" as string | null })),
    getActiveManualTask().catch(() => null),
    getTrulyActiveManualTask().catch(() => null),
    getNextQueuedManualTask().catch(() => null),
    getManualQueueDiagnostics().catch(() => ({
      totalTasks: 0, openCount: 0, selectedCount: 0, inProgressCount: 0,
      blockedCount: 0, failedCount: 0, doneCount: 0, canceledCount: 0,
      executionReadyCount: 0, staleTaskIds: [],
      healthStatus: "healthy" as const, healthReason: null,
    })),
  ]);

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

  const activeAdaptiveActions = getActiveActions(adaptiveState);
  const baseConfig = getGuardrailConfig();
  const ghCapability = checkGitHubWriteCapability();
  const latestExec: Record<string, unknown> | null = (() => {
    if (!latestExecRaw) return null;
    try {
      const parsed = typeof latestExecRaw === "string" ? JSON.parse(latestExecRaw) : latestExecRaw;
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  })();
  const latestBatchExec: Record<string, unknown> | null = (() => {
    if (!latestBatchRaw) return null;
    try {
      const parsed = typeof latestBatchRaw === "string" ? JSON.parse(latestBatchRaw) : latestBatchRaw;
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  })();

  const autonomyEnabled = process.env.AGENT_AUTONOMY_ENABLED === "1";
  const maxTasksPerRun = Math.max(1, Math.min(5, Number(process.env.AGENT_MAX_TASKS_PER_RUN ?? "3") || 3));

  const nextSelectableManualTasks = manualTasks
    .filter((t) => t.status === "OPEN" && t.executionReady)
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      title: t.title,
      source: "manual-action-queue",
      priority: t.priority,
      taskType: t.taskType,
      executionReady: true,
      blockedReason: null,
      readinessReasons: ["open_and_execution_ready"],
      requiresApproval: false,
      riskLevel: t.priority === "CRITICAL" ? "high" : t.priority === "HIGH" ? "medium" : "low",
      hasPatchPlan: Array.isArray(t.fileHints) && t.fileHints.length > 0,
      hasVerificationPlan: Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length > 0,
    }));

  const nextSelectableEngineeringTasks = tasks
    .filter((t) => t.status === "OPEN" || t.status === "READY_FOR_EXECUTION")
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      title: t.title,
      source: "engineering-backlog",
      priority: t.incidentId ? "CRITICAL" : t.status === "READY_FOR_EXECUTION" ? "HIGH" : "MEDIUM",
      taskType: t.incidentCategory ?? "ENGINEERING",
      executionReady: t.status === "READY_FOR_EXECUTION",
      blockedReason: t.status === "READY_FOR_EXECUTION" ? null : "requires_preparation_or_approval",
      readinessReasons: t.status === "READY_FOR_EXECUTION" ? ["ready_for_execution"] : ["open_task_requires_preparation"],
      requiresApproval: t.status === "OPEN",
      riskLevel: t.incidentId ? "high" : "medium",
      hasPatchPlan: t.patchPlan?.mode === "GITHUB_COMMIT",
      hasVerificationPlan: Boolean(t.validationPlan?.smokeChecks?.length || t.smokeTestBlock),
    }));

  const nextSelectableTasks = [...nextSelectableManualTasks, ...nextSelectableEngineeringTasks].slice(0, 10);

  const lastBatchExecutedCount = Number(latestBatchExec?.executedCount ?? 0) || 0;
  const lastBatchCompletedCount = Number(latestBatchExec?.completedCount ?? 0) || 0;
  const lastBatchFailedCount = Number(latestBatchExec?.failedCount ?? 0) || 0;
  const queueThroughput = {
    lastBatchExecutedCount,
    lastBatchCompletedCount,
    lastBatchFailedCount,
    completionRate: lastBatchExecutedCount > 0
      ? Number((lastBatchCompletedCount / lastBatchExecutedCount).toFixed(3))
      : 0,
    selectableNow: manualCounts.selectableCount ?? 0,
  };

  const derivedState = {
    ...state,
    openEngineeringTaskCount: openTasks.length + blockedTasks.length,
    openExecutionReadyCount: executionReadyTasks.length,
    blockedTaskCount: blockedTasks.length,
    latestExecutionTaskTitle: latestReadyForExecution?.title ?? null,
    latestExecutionStatus: latestReadyForExecution?.executionStatus ?? null,
    autonomyEnabled,
    latestBatchExecutionResult: latestBatchExec,
    lastBatchExecutedCount,
    lastBatchCompletedCount,
    lastBatchFailedCount,
    queueThroughput,
    nextSelectableTasks,
    // Phase 4: Adaptive guardrails & execution autonomy
    githubWriteEnabled: ghCapability.writeEnabled,
    patchExecutorEnabled: ghCapability.writeEnabled,
    latestExecutionTaskId: latestExec?.selectedTaskId ?? latestReadyForExecution?.id ?? null,
    latestCommitSha: latestExec?.commitSha ?? null,
    latestVerificationSummary: latestExec?.verification ?? null,
    latestFailureReason: latestExec?.failure
      ? (latestExec.failure as Record<string, unknown>)?.reason ?? null
      : null,
    latestExecutionResult: latestExec ? {
      executionStatus: latestExec.executionStatus ?? null,
      selectedSource: latestExec.selectedSource ?? null,
      selectedTaskId: latestExec.selectedTaskId ?? null,
      selectedTaskTitle: latestExec.selectedTaskTitle ?? null,
      patchApplied: latestExec.patchApplied ?? false,
      commitSha: latestExec.commitSha ?? null,
      manualTaskStatus: latestExec.manualTaskStatus ?? null,
    } : null,
    adaptiveGuardrails: {
      activeActionCount: activeAdaptiveActions.length,
      lastEvaluatedAt: adaptiveState.lastEvaluatedAt,
      actions: activeAdaptiveActions.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        reason: a.reason,
        expiresAt: a.expiresAt,
      })),
      effectiveOverrides: {
        maxOpenPositions: getEffectiveMaxOpenPositions(baseConfig.maxOpenPositions, activeAdaptiveActions),
        maxEntriesPerDay: getEffectiveMaxEntriesPerDay(baseConfig.maxEntriesPerDay, activeAdaptiveActions),
        minScoreAdjustment: getEffectiveMinScoreAdjustment(0, activeAdaptiveActions),
        cooldownAfterLossMin: getEffectiveCooldownAfterLoss(baseConfig.cooldownAfterLossMin, activeAdaptiveActions),
        suppressedSides: getSuppressedSides(activeAdaptiveActions),
      },
    },
  };

  // ─── Compute latestExecutionResult age & historical flag ──────────
  const latestExecTimestamp: string | null = (() => {
    if (!latestExec) return null;
    // Try common timestamp fields
    const ts = latestExec.timestamp ?? latestExec.executedAt ?? latestExec.resolvedAt;
    if (typeof ts === "string") return ts;
    return null;
  })();
  const latestExecAgeMinutes: number | null = (() => {
    if (!latestExecTimestamp) return null;
    const t = Date.parse(latestExecTimestamp);
    if (!Number.isFinite(t)) return null;
    return Math.round((Date.now() - t) / 60000);
  })();
  // Consider execution results older than 30 minutes as historical
  const isLatestExecutionHistorical = latestExecAgeMinutes != null ? latestExecAgeMinutes > 30 : latestExec != null;

  // ─── State reconciliation: detect and report inconsistencies ──────
  // Use trulyActiveTask (IN_PROGRESS/SELECTED only) for display
  // activeManualTask (includes OPEN+executionReady) still used for execution routing
  const reconciledActiveTask = trulyActiveTask;
  const stateConsistency = (() => {
    const issues: string[] = [];
    // Check: inProgressCount=0 but activeManualTask was showing an old task
    if (manualCounts.inProgressCount === 0 && manualCounts.selectedCount === 0 && activeManualTask && !trulyActiveTask) {
      issues.push("activeManualTask was showing queued OPEN task as active — corrected to null");
    }
    // Check: latestExecutionResult is stale
    if (isLatestExecutionHistorical) {
      const status = latestExec?.executionStatus ?? latestExec?.manualTaskStatus;
      issues.push(`latestExecutionResult is historical (${latestExecAgeMinutes ?? "?"}m old, status=${status})`);
    }
    return {
      consistent: issues.length === 0,
      issues,
    };
  })();

  return NextResponse.json({
    ok: true,
    state: derivedState,
    initialized: snapshot.source !== "stored",
    manualQueue: {
      openCount: manualCounts.openCount,
      inProgressCount: manualCounts.inProgressCount,
      blockedCount: manualCounts.blockedCount,
      executionReadyCount: manualCounts.executionReadyCount,
      selectedCount: manualCounts.selectedCount,
      selectableCount: manualCounts.selectableCount ?? 0,
      recoverableBlockedCount: manualCounts.recoverableBlockedCount ?? 0,
      idleReason: manualCounts.idleReason ?? null,
      // Only show truly active tasks (IN_PROGRESS/SELECTED), not queued OPEN ones
      activeManualTask: reconciledActiveTask ? {
        id: reconciledActiveTask.id,
        title: reconciledActiveTask.title,
        status: reconciledActiveTask.status,
        priority: reconciledActiveTask.priority,
        taskType: reconciledActiveTask.taskType,
        startedAt: reconciledActiveTask.startedAt,
        selectedAt: reconciledActiveTask.selectedAt,
      } : null,
      // Show next queued task separately from active task
      nextQueuedTask: nextQueuedTask && !reconciledActiveTask ? {
        id: nextQueuedTask.id,
        title: nextQueuedTask.title,
        priority: nextQueuedTask.priority,
        taskType: nextQueuedTask.taskType,
      } : null,
      nextTitles: manualTasks
        .filter((t) => t.status === "OPEN" || t.status === "SELECTED" || t.status === "IN_PROGRESS")
        .slice(0, 5)
        .map((t) => t.title),
      latestManualExecution: (() => {
        const recent = manualTasks.find(
          (t) => t.status === "DONE" || t.status === "FAILED" || t.status === "BLOCKED",
        );
        if (!recent) return null;
        return {
          id: recent.id,
          title: recent.title,
          status: recent.status,
          latestExecutionResult: recent.latestExecutionResult ?? null,
        };
      })(),
      diagnostics: {
        healthStatus: queueDiagnostics.healthStatus,
        healthReason: queueDiagnostics.healthReason,
        totalTasks: queueDiagnostics.totalTasks,
        failedCount: queueDiagnostics.failedCount,
        canceledCount: queueDiagnostics.canceledCount,
        staleTaskIds: queueDiagnostics.staleTaskIds,
      },
    },
    // ─── Execution result freshness ─────────────────────────────────
    latestExecutionMeta: {
      isHistorical: isLatestExecutionHistorical,
      ageMinutes: latestExecAgeMinutes,
      timestamp: latestExecTimestamp,
      status: latestExec?.executionStatus ?? null,
    },
    batchExecutionMeta: {
      timestamp: latestBatchExec?.timestamp ?? latestBatchExec?.executedAt ?? null,
      status: latestBatchExec?.executionStatus ?? null,
      requestedMax: latestBatchExec?.requestedMax ?? null,
      maxTasksPerRun,
      autonomyEnabled,
    },
    stateReconciliation: stateConsistency,
  });
}