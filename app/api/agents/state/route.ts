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
import { AGENT_LATEST_EXECUTION_KEY } from "@/lib/agents/keys";
import type { EngineeringTask } from "@/lib/agents/types";
import { listManualActionTasks, countOpenExecutionReadyManualTasks } from "@/lib/agents/manual-action-queue";

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

  const [snapshot, state, tasks, adaptiveState, latestExecRaw, manualTasks, manualCounts] = await Promise.all([
    readAgentStateSnapshot(),
    ensureAgentState(),
    listEngineeringTasks(200).then((t) =>
      t.sort((a, b) => executionVisibilityRank(a) - executionVisibilityRank(b)),
    ),
    readAdaptiveGuardrailState().catch(() => ({ actions: [], lastEvaluatedAt: null, evaluationSource: null })),
    redis ? redis.get<string>(AGENT_LATEST_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
    listManualActionTasks({ limit: 10 }).catch(() => []),
    countOpenExecutionReadyManualTasks().catch(() => ({ openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0 })),
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

  const derivedState = {
    ...state,
    openEngineeringTaskCount: openTasks.length + blockedTasks.length,
    openExecutionReadyCount: executionReadyTasks.length,
    blockedTaskCount: blockedTasks.length,
    latestExecutionTaskTitle: latestReadyForExecution?.title ?? null,
    latestExecutionStatus: latestReadyForExecution?.executionStatus ?? null,
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

  return NextResponse.json({
    ok: true,
    state: derivedState,
    initialized: snapshot.source !== "stored",
    manualQueue: {
      openCount: manualCounts.openCount,
      inProgressCount: manualCounts.inProgressCount,
      blockedCount: manualCounts.blockedCount,
      executionReadyCount: manualCounts.executionReadyCount,
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
    },
  });
}