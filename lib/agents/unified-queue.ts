/**
 * Unified Queue Summary
 *
 * Aggregates tasks from all autonomous execution sources:
 *   - manual-action-queue (chat-created tasks)
 *   - engineering-backlog (automated incident/learning tasks)
 *   - adaptive-guardrails tasks (performance remediation)
 *   - profit-engine tasks (optimization)
 *
 * Provides a single consistent view for /api/agents/state so that
 * idleReason, selectableCount, and executionReadyCount are never
 * contradictory with nextSelectableTasks.
 */

import { listManualActionTasks, countOpenExecutionReadyManualTasks, type ManualActionTask } from "@/lib/agents/manual-action-queue";
import { listEngineeringTasks } from "@/lib/agents/store";
import { checkGitHubWriteCapability } from "@/lib/agents/github-write";
import { redis } from "@/lib/redis";
import { AGENT_LATEST_EXECUTION_KEY, AGENT_LATEST_BATCH_EXECUTION_KEY } from "@/lib/agents/keys";
import type { EngineeringTask } from "@/lib/agents/types";

// ─── Selectable task shape ────────────────────────────────────────────

export interface UnifiedSelectableTask {
  id: string;
  title: string;
  source: "manual-action-queue" | "engineering-backlog" | "adaptive" | "profit-engine";
  priority: string;
  taskType: string;
  executionReady: boolean;
  blockedReason: string | null;
  readinessReasons: string[];
  requiresApproval: boolean;
  riskLevel: "low" | "medium" | "high";
  hasPatchPlan: boolean;
  hasVerificationPlan: boolean;
  execute: boolean;
  fileHints: string[];
}

// ─── Unified queue summary shape ──────────────────────────────────────

export interface UnifiedQueueSummary {
  openCount: number;
  executionReadyCount: number;
  selectableCount: number;
  blockedCount: number;
  inProgressCount: number;
  doneToday: number;
  failedToday: number;
  nextSelectableTasks: UnifiedSelectableTask[];
  idleReason: string | null;
  selectableManual: number;
  selectableEngineeringBacklog: number;
  selectableAdaptive: number;
  selectableProfitEngine: number;
}

// ─── Autonomy health shape ────────────────────────────────────────────

export interface AutonomyHealth {
  autonomyEnabled: boolean;
  githubWriteEnabled: boolean;
  patchExecutorEnabled: boolean;
  profitEngineActive: boolean;
  lastAutonomousRunAt: string | null;
  lastSuccessfulCommitSha: string | null;
  lastSuccessfulTaskTitle: string | null;
  lastFailureReason: string | null;
  stuckReason: string | null;
}

// ─── Throughput shape ─────────────────────────────────────────────────

export interface QueueThroughput {
  selectableNow: number;
  selectableManual: number;
  selectableEngineeringBacklog: number;
  selectableAdaptive: number;
  selectableProfitEngine: number;
  lastBatchExecutedCount: number;
  lastBatchCompletedCount: number;
  lastBatchFailedCount: number;
  lastBatchSuccessRate: number;
  completionRate: number;
  lastExecutionAt: string | null;
  queueBurnRate: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const TODAY_START = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

function isToday(ts: string | null | undefined): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  return Number.isFinite(t) && t >= TODAY_START;
}

function manualTaskToSelectable(t: ManualActionTask): UnifiedSelectableTask {
  return {
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
    execute: t.executionReady,
    fileHints: Array.isArray(t.fileHints) ? t.fileHints : [],
  };
}

function engineeringTaskToSelectable(t: EngineeringTask): UnifiedSelectableTask {
  const hasExplicitPlan = t.patchPlan?.mode === "GITHUB_COMMIT";
  const hasPatchPlan = hasExplicitPlan || true; // engine auto-generates on execution
  const tAny = t as unknown as Record<string, unknown>;
  const isAdaptive = !!(tAny.source === "adaptive_guardrails" || tAny.adaptiveSource);
  const isProfitEngine = !!(tAny.source === "profit_engine" || tAny.profitEngineGenerated);
  const source: UnifiedSelectableTask["source"] = isAdaptive
    ? "adaptive"
    : isProfitEngine
      ? "profit-engine"
      : "engineering-backlog";
  return {
    id: t.id,
    title: t.title,
    source,
    priority: t.incidentId ? "CRITICAL" : t.status === "READY_FOR_EXECUTION" ? "HIGH" : "MEDIUM",
    taskType: t.incidentCategory ?? "ENGINEERING",
    executionReady: true,
    blockedReason: null,
    readinessReasons: hasExplicitPlan
      ? ["ready_for_execution"]
      : ["patch_plan_missing_auto_generated: will be generated on execution"],
    requiresApproval: false,
    riskLevel: t.incidentId ? "high" : "medium",
    hasPatchPlan,
    hasVerificationPlan: !!(t.validationPlan?.smokeChecks?.length || t.smokeTestBlock),
    execute: t.status === "READY_FOR_EXECUTION" || t.executionStatus === "READY",
    fileHints: Array.isArray(t.patchPlan?.targetFiles) ? (t.patchPlan?.targetFiles ?? []) : [],
  };
}

// ─── Main builder ─────────────────────────────────────────────────────

export async function buildUnifiedQueueSummary(
  manualTasksOverride?: ManualActionTask[],
  engTasksOverride?: EngineeringTask[],
): Promise<UnifiedQueueSummary> {
  const [manualTasks, manualCounts, engTasks] = await Promise.all([
    manualTasksOverride
      ? Promise.resolve(manualTasksOverride)
      : listManualActionTasks({ limit: 50 }).catch(() => [] as ManualActionTask[]),
    countOpenExecutionReadyManualTasks().catch(() => ({
      openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0,
      selectedCount: 0, selectableCount: 0, recoverableBlockedCount: 0, idleReason: null as string | null,
    })),
    engTasksOverride
      ? Promise.resolve(engTasksOverride)
      : listEngineeringTasks(100).catch(() => [] as EngineeringTask[]),
  ]);

  // Manual queue stats
  const selectableManualTasks = manualTasks.filter((t) => t.status === "OPEN" && t.executionReady);
  const selectableManual = selectableManualTasks.length;
  const manualInProgress = manualTasks.filter((t) => t.status === "IN_PROGRESS" || t.status === "SELECTED").length;
  const manualBlocked = manualTasks.filter((t) => t.status === "BLOCKED").length;
  const manualDoneToday = manualTasks.filter((t) => t.status === "DONE" && isToday(t.updatedAt ?? t.createdAt)).length;
  const manualFailedToday = manualTasks.filter((t) => (t.status === "FAILED" || t.status === "BLOCKED") && isToday(t.updatedAt ?? t.createdAt)).length;

  // Engineering backlog stats
  const openEngTasks = engTasks.filter(
    (t) => t.status === "OPEN" || t.status === "READY_FOR_EXECUTION" || t.status === "READY_FOR_PUSH",
  );
  const engInProgress = engTasks.filter((t) => t.status === "IN_PROGRESS").length;
  const engBlocked = engTasks.filter((t) => t.status === "BLOCKED").length;
  const engDoneToday = engTasks.filter((t) => t.status === "DONE" && isToday(t.updatedAt ?? t.createdAt)).length;
  const engFailedToday = engTasks.filter((t) => t.status === "FAILED" && isToday(t.updatedAt ?? t.createdAt)).length;

  // Partition engineering by source
  const selectableAdaptiveTasks = openEngTasks.filter((t) => {
    const tAny = t as unknown as Record<string, unknown>;
    return tAny.source === "adaptive_guardrails" || !!tAny.adaptiveSource;
  });
  const selectableProfitEngineTasks = openEngTasks.filter((t) => {
    const tAny = t as unknown as Record<string, unknown>;
    return tAny.source === "profit_engine" || !!tAny.profitEngineGenerated;
  });
  const selectableEngBacklogTasks = openEngTasks.filter((t) => {
    const tAny = t as unknown as Record<string, unknown>;
    return (
      tAny.source !== "adaptive_guardrails" &&
      !tAny.adaptiveSource &&
      tAny.source !== "profit_engine" &&
      !tAny.profitEngineGenerated
    );
  });

  const selectableEngineeringBacklog = selectableEngBacklogTasks.length;
  const selectableAdaptive = selectableAdaptiveTasks.length;
  const selectableProfitEngine = selectableProfitEngineTasks.length;

  // Unified counters
  const openCount = manualCounts.openCount + openEngTasks.length;
  const executionReadyCount = selectableManual + openEngTasks.length;
  const selectableCount = selectableManual + openEngTasks.length;
  const blockedCount = manualBlocked + engBlocked;
  const inProgressCount = manualInProgress + engInProgress;
  const doneToday = manualDoneToday + engDoneToday;
  const failedToday = manualFailedToday + engFailedToday;

  // Build next selectable tasks (max 10, manual first)
  const selectableManualItems = selectableManualTasks.slice(0, 5).map(manualTaskToSelectable);
  const selectableEngItems = openEngTasks.slice(0, 5).map(engineeringTaskToSelectable);
  const nextSelectableTasks = [...selectableManualItems, ...selectableEngItems].slice(0, 10);

  // Compute idleReason — never contradict nextSelectableTasks
  let idleReason: string | null = null;
  if (selectableCount === 0) {
    // Only use manualCounts.idleReason when engineering backlog is genuinely empty
    idleReason = manualCounts.idleReason ?? "no_work_available";
  }
  // If engineering backlog has selectable tasks, reset any manual-only idleReason
  if (selectableEngineeringBacklog > 0 || selectableAdaptive > 0 || selectableProfitEngine > 0) {
    idleReason = null; // selectable tasks available from engineering-backlog
  }

  return {
    openCount,
    executionReadyCount,
    selectableCount,
    blockedCount,
    inProgressCount,
    doneToday,
    failedToday,
    nextSelectableTasks,
    idleReason,
    selectableManual,
    selectableEngineeringBacklog,
    selectableAdaptive,
    selectableProfitEngine,
  };
}

// ─── Autonomy health builder ──────────────────────────────────────────

export async function buildAutonomyHealth(
  latestExec: Record<string, unknown> | null,
  latestBatchExec: Record<string, unknown> | null,
  profitEngineActive: boolean,
): Promise<AutonomyHealth> {
  const ghCapability = checkGitHubWriteCapability();
  const autonomyEnabled = process.env.AGENT_AUTONOMY_ENABLED === "1";

  // Last run timestamp: prefer batch execution, fallback to single
  const lastAutonomousRunAt: string | null = (() => {
    const ts =
      latestBatchExec?.executedAt ??
      latestBatchExec?.timestamp ??
      latestExec?.executedAt ??
      latestExec?.timestamp ??
      latestExec?.resolvedAt ??
      null;
    return typeof ts === "string" ? ts : null;
  })();

  // Last successful commit sha — prefer batch result commitSha, then single
  const lastSuccessfulCommitSha: string | null = (() => {
    // Batch results array
    const results = Array.isArray(latestBatchExec?.results) ? (latestBatchExec!.results as Record<string, unknown>[]) : [];
    for (const r of results) {
      if (r.status === "COMPLETED" && typeof r.commitSha === "string" && r.commitSha) {
        return r.commitSha;
      }
    }
    // Single exec
    if (typeof latestExec?.commitSha === "string" && latestExec.commitSha) return latestExec.commitSha;
    return null;
  })();

  // Last successful task title
  const lastSuccessfulTaskTitle: string | null = (() => {
    const results = Array.isArray(latestBatchExec?.results) ? (latestBatchExec!.results as Record<string, unknown>[]) : [];
    for (const r of results) {
      if (r.status === "COMPLETED" && typeof r.title === "string") return r.title;
    }
    if (typeof latestExec?.selectedTaskTitle === "string") return latestExec.selectedTaskTitle;
    return null;
  })();

  // Last failure reason
  const lastFailureReason: string | null = (() => {
    if (typeof latestBatchExec?.stoppedReason === "string" && latestBatchExec.stoppedReason !== "null") {
      return latestBatchExec.stoppedReason;
    }
    const results = Array.isArray(latestBatchExec?.results) ? (latestBatchExec!.results as Record<string, unknown>[]) : [];
    for (const r of results) {
      if ((r.status === "FAILED" || r.status === "BLOCKED") && typeof r.resolution === "object") {
        const res = r.resolution as Record<string, unknown>;
        if (typeof res?.reason === "string") return res.reason;
      }
    }
    if (typeof latestExec?.failure === "object" && latestExec.failure) {
      const f = latestExec.failure as Record<string, unknown>;
      if (typeof f.reason === "string") return f.reason;
    }
    return null;
  })();

  // Stuck reason — if last run had no completed tasks and no selectable tasks
  let stuckReason: string | null = null;
  if (!autonomyEnabled) {
    stuckReason = "autonomy_disabled";
  } else if (!ghCapability.writeEnabled) {
    stuckReason = `github_write_disabled: ${ghCapability.reason}`;
  }

  return {
    autonomyEnabled,
    githubWriteEnabled: ghCapability.writeEnabled,
    patchExecutorEnabled: ghCapability.writeEnabled,
    profitEngineActive,
    lastAutonomousRunAt,
    lastSuccessfulCommitSha,
    lastSuccessfulTaskTitle,
    lastFailureReason,
    stuckReason,
  };
}

// ─── Throughput builder ───────────────────────────────────────────────

export function buildQueueThroughput(
  unifiedQueue: UnifiedQueueSummary,
  latestBatchExec: Record<string, unknown> | null,
  latestExec: Record<string, unknown> | null,
  openTaskCount: number,
): QueueThroughput {
  const lastBatchExecutedCount = Number(latestBatchExec?.executedCount ?? 0) || 0;
  const lastBatchCompletedCount = Number(latestBatchExec?.completedCount ?? 0) || 0;
  const lastBatchFailedCount = Number(latestBatchExec?.failedCount ?? 0) || 0;
  const lastBatchSuccessRate = lastBatchExecutedCount > 0
    ? Number((lastBatchCompletedCount / lastBatchExecutedCount).toFixed(3))
    : 0;

  const lastExecutionAt: string | null = (() => {
    const ts =
      latestBatchExec?.executedAt ??
      latestBatchExec?.timestamp ??
      latestExec?.executedAt ??
      latestExec?.timestamp ??
      latestExec?.validatedAt ??
      null;
    return typeof ts === "string" ? ts : null;
  })();

  const queueBurnRate = openTaskCount > 0 && lastBatchCompletedCount > 0
    ? Number((lastBatchCompletedCount / openTaskCount).toFixed(4))
    : 0;

  return {
    selectableNow: unifiedQueue.selectableCount,
    selectableManual: unifiedQueue.selectableManual,
    selectableEngineeringBacklog: unifiedQueue.selectableEngineeringBacklog,
    selectableAdaptive: unifiedQueue.selectableAdaptive,
    selectableProfitEngine: unifiedQueue.selectableProfitEngine,
    lastBatchExecutedCount,
    lastBatchCompletedCount,
    lastBatchFailedCount,
    lastBatchSuccessRate,
    completionRate: lastBatchSuccessRate,
    lastExecutionAt,
    queueBurnRate,
  };
}
