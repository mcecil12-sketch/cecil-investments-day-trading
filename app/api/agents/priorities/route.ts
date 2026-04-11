/**
 * GET /api/agents/priorities
 * Returns the current scored and ranked task list from the Engineering Manager.
 * Use ?refresh=1 to trigger a fresh orchestration pass.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { readEmBrief, runEmOrchestration } from "@/lib/agents/engineeringManager";
import { getCriticalTasks, partitionCriticalTasks } from "@/lib/redis";
import { readAdaptiveGuardrailState, getActiveActions } from "@/lib/agents/adaptiveGuardrails";
import { checkGitHubWriteCapability } from "@/lib/agents/github-write";
import { listEngineeringTasks } from "@/lib/agents/store";
import { classifyTaskAsActionable } from "@/lib/agents/patch-executor";
import { redis } from "@/lib/redis";
import { AGENT_LATEST_EXECUTION_KEY } from "@/lib/agents/keys";
import { listManualActionTasks, countOpenExecutionReadyManualTasks } from "@/lib/agents/manual-action-queue";

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";

  if (refresh) {
    const result = await runEmOrchestration();
    const criticalTasks = await getCriticalTasks().catch(() => []);
    const { blocking, synthetic } = partitionCriticalTasks(criticalTasks);
    const criticalEntries = blocking.map((t) => ({
      taskId: t.id,
      title: `[CRITICAL] ${t.incidentCode}: ${t.symbol} — ${t.detail}`,
      priority: "CRITICAL" as const,
      source: "protection-integrity",
      createdAt: t.createdAt,
    }));
    const [manualTasks, manualCounts] = await Promise.all([
      listManualActionTasks({ limit: 10 }).catch(() => []),
      countOpenExecutionReadyManualTasks().catch(() => ({ openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0 })),
    ]);
    const openManualTasks = manualTasks.filter(
      (t) => t.status === "OPEN" || t.status === "SELECTED" || t.status === "IN_PROGRESS",
    );

    // Determine selectedSource
    let selectedSource: string = "autonomous-backlog";
    let selectedTaskId: string | null = result.selectedTaskId;
    let selectedTaskTitle: string | null = result.selectedTaskTitle;

    if (blocking.length > 0) {
      selectedSource = "critical-task-queue";
      selectedTaskId = criticalEntries[0]?.taskId ?? selectedTaskId;
      selectedTaskTitle = criticalEntries[0]?.title ?? selectedTaskTitle;
    } else if (openManualTasks.length > 0 && openManualTasks[0].executionReady) {
      selectedSource = "manual-action-queue";
      selectedTaskId = openManualTasks[0].id;
      selectedTaskTitle = openManualTasks[0].title;
    }

    return NextResponse.json({
      ok: true,
      fresh: true,
      critical: criticalEntries.length,
      unresolvedCriticalCount: criticalTasks.length,
      blockingCriticalCount: blocking.length,
      syntheticCriticalCount: synthetic.length,
      selfHealPending: blocking.length > 0,
      criticalTasks: criticalEntries,
      selectedSource,
      selectedTaskId,
      selectedTaskTitle,
      strategistBias: result.strategist.marketBias,
      scoredTasks: result.scoredTasks,
      manualQueueCount: manualCounts.openCount,
      manualExecutionReadyCount: manualCounts.executionReadyCount,
      manualTasks: openManualTasks.slice(0, 5).map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        taskType: t.taskType,
        status: t.status,
        executionReady: t.executionReady,
        createdAt: t.createdAt,
      })),
    });
  }

  const brief = await readEmBrief().catch(() => null);
  if (!brief) {
    return NextResponse.json({ ok: true, fresh: false, scoredTasks: [], message: "No priorities computed yet. POST /api/agents/run to initialize." });
  }

  const [criticalTasks, adaptiveState, tasks, latestExecRaw, manualTasks, manualCounts] = await Promise.all([
    getCriticalTasks().catch(() => []),
    readAdaptiveGuardrailState().catch(() => ({ actions: [], lastEvaluatedAt: null, evaluationSource: null })),
    listEngineeringTasks(100).catch(() => []),
    redis ? redis.get<string>(AGENT_LATEST_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
    listManualActionTasks({ limit: 10 }).catch(() => []),
    countOpenExecutionReadyManualTasks().catch(() => ({ openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0 })),
  ]);
  const activeAdaptiveActions = getActiveActions(adaptiveState);
  const ghCapability = checkGitHubWriteCapability();
  const executionReadyTasks = tasks.filter(
    (t) => t.status === "READY_FOR_EXECUTION" || t.executionStatus === "READY",
  );
  const latestExec: Record<string, unknown> | null = (() => {
    if (!latestExecRaw) return null;
    try {
      const parsed = typeof latestExecRaw === "string" ? JSON.parse(latestExecRaw) : latestExecRaw;
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  })();
  const criticalEntries = criticalTasks.map((t) => ({
    taskId: t.id,
    title: `[CRITICAL] ${t.incidentCode}: ${t.symbol} — ${t.detail}`,
    priority: "CRITICAL" as const,
    source: "protection-integrity",
    createdAt: t.createdAt,
    synthetic: t.synthetic ?? false,
  }));

  const { blocking: blockingCritical, synthetic: syntheticCritical } = partitionCriticalTasks(criticalTasks);

  // CRITICAL tasks override normal priority — surface at top
  // Only BLOCKING (real) incidents should trigger self-heal pending
  const selfHealPending = blockingCritical.length > 0;
  // Selected task should prefer blocking (live) incidents over synthetic
  const blockingEntries = criticalEntries.filter((e) => !e.synthetic);

  const openManualTasks = manualTasks.filter(
    (t) => t.status === "OPEN" || t.status === "SELECTED" || t.status === "IN_PROGRESS",
  );

  // Determine selectedSource applying priority cascade
  let selectedSource: string = "autonomous-backlog";
  let resolvedSelectedTaskId: string | null = brief.selectedTaskId;
  let resolvedSelectedTaskTitle: string | null = brief.selectedTaskTitle;

  if (selfHealPending) {
    selectedSource = "critical-task-queue";
    resolvedSelectedTaskId = blockingEntries[0]?.taskId ?? brief.selectedTaskId;
    resolvedSelectedTaskTitle = blockingEntries[0]?.title ?? brief.selectedTaskTitle;
  } else if (openManualTasks.length > 0 && openManualTasks[0].executionReady) {
    selectedSource = "manual-action-queue";
    resolvedSelectedTaskId = openManualTasks[0].id;
    resolvedSelectedTaskTitle = openManualTasks[0].title;
  }

  return NextResponse.json({
    ok: true,
    fresh: false,
    id: brief.id,
    createdAt: brief.createdAt,
    selectedSource,
    selectedTaskId: resolvedSelectedTaskId,
    selectedTaskTitle: resolvedSelectedTaskTitle,
    strategistBias: brief.strategistBias,
    learningSignalsSummary: brief.learningSignalsSummary,
    critical: blockingCritical.length,
    unresolvedCriticalCount: criticalTasks.length,
    blockingCriticalCount: blockingCritical.length,
    syntheticCriticalCount: syntheticCritical.length,
    selfHealPending,
    criticalTasks: criticalEntries,
    scoredTasks: brief.scoredTasks,
    manualQueueCount: manualCounts.openCount,
    manualExecutionReadyCount: manualCounts.executionReadyCount,
    manualTasks: openManualTasks.slice(0, 5).map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      taskType: t.taskType,
      status: t.status,
      executionReady: t.executionReady,
      createdAt: t.createdAt,
    })),
    // Phase 4: Adaptive guardrails & execution autonomy
    executionReadyTaskCount: executionReadyTasks.length,
    patchCapable: ghCapability.writeEnabled,
    githubWriteAvailable: ghCapability.writeEnabled,
    githubWriteReason: ghCapability.reason ?? null,
    adaptiveGuardrails: {
      activeActionCount: activeAdaptiveActions.length,
      lastEvaluatedAt: adaptiveState.lastEvaluatedAt,
      activeActions: activeAdaptiveActions.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        reason: a.reason,
        expiresAt: a.expiresAt,
      })),
    },
    latestAutonomousAction: latestExec ? {
      executionStatus: latestExec.executionStatus ?? null,
      selectedTaskId: latestExec.selectedTaskId ?? null,
      selectedTaskTitle: latestExec.selectedTaskTitle ?? null,
      patchApplied: latestExec.patchApplied ?? false,
      commitSha: latestExec.commitSha ?? null,
    } : null,
  });
}
