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
import { readProfitEngineStatus } from "@/lib/agents/profitEngine";
import { buildUnifiedQueueSummary, buildAutonomyHealth, buildQueueThroughput } from "@/lib/agents/unified-queue";
import { readFunnelRecoveryState } from "@/lib/agents/funnel-recovery";
import { buildRImpactQueue, getTopRImpactTaskIds } from "@/lib/agents/r-impact";
import { getDedupStats } from "@/lib/agents/task-dedup";

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

// ─── Sanitize verification probes stored before the json-strip fix ──
// Strips nested /api/agents/state JSON from any probe.json fields that
// were persisted in Redis before verification-runner was patched.
// Only keeps compact fields: route, ok, status, method, reason, checkedAt.
const STALE_PROBE_JSON_KEYS = new Set([
  "state", "manualQueue", "unifiedQueue", "autonomyHealth",
  "latestExecutionMeta", "batchExecutionMeta", "latestBatchExecutionResult",
  "latestExecutionResult", "queueThroughput", "nextSelectableTasks",
  "profitEngine", "stateReconciliation",
]);

function sanitizeVerificationSummary(verification: unknown): unknown {
  return sanitizeVerificationSummaryWithCount(verification).result;
}

function sanitizeVerificationSummaryWithCount(verification: unknown): { result: unknown; sanitizedCount: number } {
  if (!verification || typeof verification !== "object") return { result: verification, sanitizedCount: 0 };
  const v = verification as Record<string, unknown>;
  const details = v.details;
  if (!details || typeof details !== "object") return { result: verification, sanitizedCount: 0 };
  const d = details as Record<string, unknown>;
  if (!Array.isArray(d.probes)) return { result: verification, sanitizedCount: 0 };
  let sanitizedCount = 0;
  const sanitizedProbes = (d.probes as unknown[]).map((probe) => {
    if (!probe || typeof probe !== "object") return probe;
    const p = probe as Record<string, unknown>;
    if (!("json" in p)) return p; // no json field — nothing to strip
    sanitizedCount++;
    // Unconditionally remove the json field — may contain recursive state blobs
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { json: _removed, ...rest } = p;
    return rest;
  });
  return {
    result: { ...v, details: { ...d, probes: sanitizedProbes } },
    sanitizedCount,
  };
}

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const [snapshot, state, tasks, adaptiveState, latestExecRaw, latestBatchRaw, manualTasks, manualCounts, activeManualTask, trulyActiveTask, nextQueuedTask, queueDiagnostics, profitEngineStatus, funnelRecoveryState, dedupStats] = await Promise.all([
    readAgentStateSnapshot(),
    ensureAgentState(),
    listEngineeringTasks(200).then((t) =>
      t.sort((a, b) => executionVisibilityRank(a) - executionVisibilityRank(b)),
    ),
    readAdaptiveGuardrailState().catch(() => ({ actions: [], lastEvaluatedAt: null, evaluationSource: null })),
    redis ? redis.get<string>(AGENT_LATEST_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
    redis ? redis.get<string>(AGENT_LATEST_BATCH_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
    listManualActionTasks({ limit: 50 }).catch(() => []),
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
    readProfitEngineStatus().catch(() => null),
    readFunnelRecoveryState().catch(() => null),
    getDedupStats().catch(() => ({ activeLocks: 0, skippedDuplicateExecutionCount: 0, skippedInsufficientDataCount: 0 })),
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

  // ─── Canonical execution record ────────────────────────────────────
  // Pick the best execution snapshot: prefer BATCH_COMPLETED+commitSha over
  // BATCH_PARTIAL/null-commitSha; within a 1-hour window freshness + quality wins.
  const canonicalExec: Record<string, unknown> | null = (() => {
    if (!latestExec && !latestBatchExec) return null;
    if (!latestExec) return latestBatchExec;
    if (!latestBatchExec) return latestExec;
    const tsOf = (r: Record<string, unknown>): number => {
      const ts = r.executedAt ?? r.timestamp ?? r.validatedAt;
      if (typeof ts !== "string") return 0;
      const d = Date.parse(ts);
      return Number.isFinite(d) ? d : 0;
    };
    const execTs = tsOf(latestExec);
    const batchTs = tsOf(latestBatchExec);
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const execCompleted = latestExec.executionStatus === "BATCH_COMPLETED";
    const batchCompleted = latestBatchExec.executionStatus === "BATCH_COMPLETED";
    const execHasCommit = typeof latestExec.commitSha === "string" && latestExec.commitSha.length > 0;
    const batchHasCommit = typeof latestBatchExec.commitSha === "string" && latestBatchExec.commitSha.length > 0;
    // Prefer whichever has a commitSha (within 1-hour window)
    if (execHasCommit && !batchHasCommit && execTs > batchTs - ONE_HOUR_MS) return latestExec;
    if (batchHasCommit && !execHasCommit && batchTs > execTs - ONE_HOUR_MS) return latestBatchExec;
    // Prefer BATCH_COMPLETED over non-completed within 1-hour window
    if (execCompleted && !batchCompleted && execTs > batchTs - ONE_HOUR_MS) return latestExec;
    if (batchCompleted && !execCompleted && batchTs > execTs - ONE_HOUR_MS) return latestBatchExec;
    // Fresher timestamp wins
    return execTs >= batchTs ? latestExec : latestBatchExec;
  })();

  // Strip any stale top-level recursive keys from the canonical exec record.
  // These keys should never appear in stored batch results, but may have leaked
  // from older Redis snapshots captured before the probe-sanitization fix.
  const EXEC_RECORD_STRIP_KEYS = new Set([
    "state", "manualQueue", "unifiedQueue", "autonomyHealth", "profitEngine",
    "stateReconciliation", "initialized",
  ]);
  const sanitizedCanonicalExec: Record<string, unknown> | null = canonicalExec
    ? Object.fromEntries(
        Object.entries(canonicalExec).filter(([k]) => !EXEC_RECORD_STRIP_KEYS.has(k))
      )
    : null;

  const autonomyEnabled = process.env.AGENT_AUTONOMY_ENABLED === "1";
  const maxTasksPerRun = Math.max(1, Math.min(5, Number(process.env.AGENT_MAX_TASKS_PER_RUN ?? "3") || 3));

  // ─── Unified queue summary ──────────────────────────────────────────
  // Combines manual-action-queue + engineering-backlog + adaptive + profit-engine
  const unifiedQueue = await buildUnifiedQueueSummary(manualTasks, tasks).catch(() => ({
    openCount: 0, executionReadyCount: 0, selectableCount: 0, blockedCount: 0,
    inProgressCount: 0, doneToday: 0, failedToday: 0, nextSelectableTasks: [],
    idleReason: "unified_queue_build_failed", selectableManual: 0,
    selectableEngineeringBacklog: 0, selectableAdaptive: 0, selectableProfitEngine: 0,
  }));

  // nextSelectableTasks is now sourced from the unified queue
  const nextSelectableTasks = unifiedQueue.nextSelectableTasks;

  // Use sanitizedCanonicalExec (stale recursive keys stripped) for all batch-level fields
  const canon = sanitizedCanonicalExec;
  const lastBatchExecutedCount = Number(canon?.executedCount ?? 0) || 0;
  const lastBatchCompletedCount = Number(canon?.completedCount ?? 0) || 0;
  const lastBatchFailedCount = Number(canon?.failedCount ?? 0) || 0;

  // Derive last execution timestamp from canonical exec
  const lastExecutionAt: string | null = (() => {
    const ts =
      canon?.executedAt ??
      canon?.timestamp ??
      canon?.validatedAt ??
      null;
    return typeof ts === "string" ? ts : null;
  })();

  // Queue burn rate: completedCount / openTaskCount (last batch, as ratio)
  const openTaskCount = openTasks.length;
  const queueBurnRate = openTaskCount > 0 && lastBatchCompletedCount > 0
    ? Number((lastBatchCompletedCount / openTaskCount).toFixed(4))
    : 0;

  const lastBatchSuccessRate = lastBatchExecutedCount > 0
    ? Number((lastBatchCompletedCount / lastBatchExecutedCount).toFixed(3))
    : 0;

  // Unified throughput — selectableNow accounts for all sources; canonical exec drives lastExecutionAt
  const queueThroughput = buildQueueThroughput(unifiedQueue, canon, canon, openTaskCount);

  // Sanitize verification probes and capture count for diagnostics
  const verificationSanitized = sanitizeVerificationSummaryWithCount(canon?.verification ?? null);

  // ─── R-Impact queue (Agent Workflow v2) ────────────────────────────
  // Build the R-impact ranked queue from all open tasks
  const rImpactQueue = buildRImpactQueue(
    manualTasks.filter((t) => t.status === "OPEN" || t.status === "SELECTED"),
    tasks.filter((t) => t.status === "OPEN" || t.status === "READY_FOR_EXECUTION"),
    { maxResults: 10 },
  );
  const topExpectedRTasks = getTopRImpactTaskIds(rImpactQueue, 3);

  const derivedState = {
    ...state,
    openEngineeringTaskCount: openTasks.length + blockedTasks.length,
    openExecutionReadyCount: executionReadyTasks.length,
    blockedTaskCount: blockedTasks.length,
    latestExecutionTaskTitle: latestReadyForExecution?.title ?? null,
    latestExecutionStatus: latestReadyForExecution?.executionStatus ?? null,
    autonomyEnabled,
    // canonicalExec: freshest BATCH_COMPLETED+commitSha wins over stale BATCH_PARTIAL
    latestBatchExecutionResult: canon,
    lastBatchExecutedCount: Number(latestBatchExec?.executedCount ?? 0) || 0,
    lastBatchCompletedCount: Number(latestBatchExec?.completedCount ?? 0) || 0,
    lastBatchFailedCount: Number(latestBatchExec?.failedCount ?? 0) || 0,
    queueThroughput,
    nextSelectableTasks,
    // Phase 4: Adaptive guardrails & execution autonomy
    githubWriteEnabled: ghCapability.writeEnabled,
    patchExecutorEnabled: ghCapability.writeEnabled,
    latestExecutionTaskId: canon?.selectedTaskId ?? latestReadyForExecution?.id ?? null,
    latestCommitSha: canon?.commitSha ?? null,
    latestVerificationSummary: verificationSanitized.result,
    latestFailureReason: canon?.failure
      ? (canon.failure as Record<string, unknown>)?.reason ?? null
      : null,
    latestExecutionResult: canon ? {
      executionStatus: canon.executionStatus ?? null,
      selectedSource: canon.selectedSource ?? null,
      selectedTaskId: canon.selectedTaskId ?? null,
      selectedTaskTitle: canon.selectedTaskTitle ?? null,
      patchApplied: canon.patchApplied ?? false,
      commitSha: canon.commitSha ?? null,
      manualTaskStatus: canon.manualTaskStatus ?? null,
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
    if (!canon) return null;
    // Use canonical exec timestamp — avoids stale probe data
    const ts =
      canon.executedAt ??
      canon.timestamp ??
      canon.resolvedAt;
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
  const isLatestExecutionHistorical = latestExecAgeMinutes != null ? latestExecAgeMinutes > 30 : canon != null;

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
      const status = canon?.executionStatus ?? canon?.manualTaskStatus;
      issues.push(`latestExecutionResult is historical (${latestExecAgeMinutes ?? "?"}m old, status=${status})`);
    }
    // Check: latestExec and latestBatchExec are out of sync
    const execStatus = latestExec?.executionStatus;
    const batchStatus = latestBatchExec?.executionStatus;
    const execSyncOk = !execStatus || !batchStatus || execStatus === batchStatus;
    if (!execSyncOk) {
      issues.push(`execution records inconsistent: latestExec.executionStatus=${execStatus} vs latestBatchExec.executionStatus=${batchStatus} — using canonical (${canon?.executionStatus})`);
    }
    // Check: no stale nested state in verification probes (recursive pollution)
    const hasStaleVerificationProbes = (() => {
      const v = canon?.verification as Record<string, unknown> | undefined;
      const probes = (v?.details as Record<string, unknown> | undefined)?.probes;
      if (!Array.isArray(probes)) return false;
      return probes.some((p) => {
        if (!p || typeof p !== "object") return false;
        const pj = (p as Record<string, unknown>).json;
        if (!pj || typeof pj !== "object") return false;
        return Object.keys(pj as object).some((k) => STALE_PROBE_JSON_KEYS.has(k));
      });
    })();
    if (hasStaleVerificationProbes) {
      issues.push("verification probes contain stale nested state JSON — sanitized in this response");
    }
    // consistent=true when a commitSha is present and the selectable counts agree
    const hasCommit = typeof canon?.commitSha === "string" && canon.commitSha.length > 0;
    const isConsistent = hasCommit && queueThroughput.selectableNow === nextSelectableTasks.length;
    return {
      consistent: isConsistent,
      canonicalSource: canonicalExec === latestExec ? "latest_exec" : "latest_batch_exec",
      staleProbeSanitized: hasStaleVerificationProbes,
      issues,
    };
  })();

  // ─── Autonomy health ────────────────────────────────────────────────
  const autonomyHealth = await buildAutonomyHealth(
    latestExec,
    latestBatchExec,
    profitEngineStatus?.engineActive ?? false,
  ).catch(() => ({
    autonomyEnabled: process.env.AGENT_AUTONOMY_ENABLED === "1",
    githubWriteEnabled: false,
    patchExecutorEnabled: false,
    profitEngineActive: false,
    lastAutonomousRunAt: null,
    lastSuccessfulCommitSha: null,
    lastSuccessfulTaskTitle: null,
    lastFailureReason: null,
    stuckReason: "autonomy_health_build_failed",
  }));

  // ─── Merge reconciliation + diagnostics into state ────────────────
  // These must live under `.state` so clients querying `.state.stateReconciliation`
  // and `.state.verificationSummarySanitized` receive the correct values.
  const finalState = {
    ...derivedState,
    stateReconciliation: stateConsistency,
    verificationSummarySanitized: verificationSanitized.sanitizedCount > 0,
    nestedProbeJsonRemovedCount: verificationSanitized.sanitizedCount,
  };

  return NextResponse.json({
    ok: true,
    state: finalState,
    initialized: snapshot.source !== "stored",
    // ─── Unified queue (authoritative source of truth for all task sources) ─
    unifiedQueue,
    // ─── Autonomy health ─────────────────────────────────────────────
    autonomyHealth,
    manualQueue: {
      openCount: manualCounts.openCount,
      inProgressCount: manualCounts.inProgressCount,
      blockedCount: manualCounts.blockedCount,
      executionReadyCount: manualCounts.executionReadyCount,
      selectedCount: manualCounts.selectedCount,
      selectableCount: manualCounts.selectableCount ?? 0,
      recoverableBlockedCount: manualCounts.recoverableBlockedCount ?? 0,
      // Use unifiedQueue.idleReason — never contradicts nextSelectableTasks
      // idleReason is null when ANY queue source has selectable tasks (req 6)
      idleReason: nextSelectableTasks.length > 0 ? null : unifiedQueue.idleReason,
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
      // timestamp from canonical exec — never null if execution ran
      timestamp: latestExecTimestamp,
      status: canon?.executionStatus ?? null,
      commitSha: canon?.commitSha ?? null,
      stoppedReason: canon?.stoppedReason ?? null,
    },
    batchExecutionMeta: {
      timestamp: (canon?.executedAt ?? canon?.timestamp) as string | null ?? null,
      status: canon?.executionStatus ?? null,
      commitSha: canon?.commitSha ?? null,
      executedCount: Number(canon?.executedCount ?? 0) || 0,
      completedCount: Number(canon?.completedCount ?? 0) || 0,
      stoppedReason: canon?.stoppedReason ?? null,
      requestedMax: canon?.requestedMax ?? null,
      maxTasksPerRun,
      autonomyEnabled,
    },
    stateReconciliation: stateConsistency,

    // ─── Verification sanitization diagnostics (also mirrored under state) ─
    verificationDiagnostics: {
      verificationSummarySanitized: verificationSanitized.sanitizedCount > 0,
      nestedProbeJsonRemovedCount: verificationSanitized.sanitizedCount,
    },

    // ─── Profit Optimization Engine ─────────────────────────────────
    profitEngine: profitEngineStatus
      ? {
          active: profitEngineStatus.engineActive,
          funnelBlocked: profitEngineStatus.funnelBlocked,
          funnelBlockedReason: profitEngineStatus.funnelBlockedReason,
          lastRunAt: profitEngineStatus.lastRunAt,
          lastOptimizationType: profitEngineStatus.lastOptimizationType,
          lastOptimizationAt: profitEngineStatus.lastOptimizationAt,
          winRate: profitEngineStatus.lastWinRate,
          avgR: profitEngineStatus.lastAvgR,
          tradeCount: profitEngineStatus.lastTradeCount,
          optimizationImpact: profitEngineStatus.optimizationImpact,
          recentLog: (profitEngineStatus.evaluationLog ?? []).slice(-5),
        }
      : {
          active: false,
          funnelBlocked: false,
          funnelBlockedReason: null,
          lastRunAt: null,
          lastOptimizationType: null,
          lastOptimizationAt: null,
          winRate: null,
          avgR: null,
          tradeCount: null,
          optimizationImpact: null,
          recentLog: [],
        },

    // ─── Agent Workflow v2: Funnel Recovery ─────────────────────────
    funnelRecovery: funnelRecoveryState
      ? {
          funnelBlocked: funnelRecoveryState.funnelBlocked,
          funnelBlockedReason: funnelRecoveryState.funnelBlockedReason,
          funnelBlockedStage: funnelRecoveryState.funnelBlockedStage,
          funnelRecoveryMode: funnelRecoveryState.funnelRecoveryMode,
          lastFunnelBlockedAt: funnelRecoveryState.lastFunnelBlockedAt,
          lastFunnelHealthyAt: funnelRecoveryState.lastFunnelHealthyAt,
        }
      : {
          funnelBlocked: false,
          funnelBlockedReason: null,
          funnelBlockedStage: null,
          funnelRecoveryMode: false,
          lastFunnelBlockedAt: null,
          lastFunnelHealthyAt: null,
        },

    // ─── Agent Workflow v2: R-Impact Queue ──────────────────────────
    rImpactQueue: {
      topExpectedRTasks,
      queueLength: rImpactQueue.length,
      lastRImpactExecution: canon?.executedAt ?? canon?.timestamp ?? null,
      tasks: rImpactQueue.slice(0, 5).map((t) => ({
        taskId: t.taskId,
        title: t.title,
        source: t.source,
        expectedRImpact: t.expectedRImpact,
        confidence: t.confidence,
        evidenceFreshness: t.evidenceFreshness,
        affectedMetric: t.affectedMetric,
        rank: t.rank,
      })),
    },

    // ─── Agent Workflow v2: Duplicate Suppression ────────────────────
    duplicateSuppression: {
      activeLocks: dedupStats.activeLocks,
      skippedDuplicateExecutionCount: dedupStats.skippedDuplicateExecutionCount,
      skippedInsufficientDataCount: dedupStats.skippedInsufficientDataCount,
    },

    // ─── Agent Workflow v2: Execution Stats ──────────────────────────
    executionStats: {
      skippedLowImpactCount: 0, // populated by execute route in future runs
      skippedDuplicateFixClassCount: dedupStats.skippedDuplicateExecutionCount,
    },
  });
}