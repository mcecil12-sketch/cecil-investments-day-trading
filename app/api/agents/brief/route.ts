/**
 * GET /api/agents/brief
 * Returns the current News/Policy Strategist brief and Engineering Manager
 * brief summary. Useful for inspecting what the agent system currently believes.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { getStrategistBrief } from "@/lib/agents/newsStrategist";
import { readEmBrief } from "@/lib/agents/engineeringManager";
import { getCriticalTasks, partitionCriticalTasks } from "@/lib/redis";
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
import { listEngineeringTasks } from "@/lib/agents/store";
import { redis } from "@/lib/redis";
import { AGENT_LATEST_EXECUTION_KEY } from "@/lib/agents/keys";
import { listManualActionTasks, countOpenExecutionReadyManualTasks } from "@/lib/agents/manual-action-queue";

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const [strategist, emBrief, criticalTasks, adaptiveState, tasks, latestExecRaw, manualTasks, manualCounts] = await Promise.all([
    getStrategistBrief().catch(() => null),
    readEmBrief().catch(() => null),
    getCriticalTasks().catch(() => []),
    readAdaptiveGuardrailState().catch(() => ({ actions: [], lastEvaluatedAt: null, evaluationSource: null })),
    listEngineeringTasks(100).catch(() => []),
    redis ? redis.get<string>(AGENT_LATEST_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
    listManualActionTasks({ limit: 5 }).catch(() => []),
    countOpenExecutionReadyManualTasks().catch(() => ({ openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0 })),
  ]);

  const criticalCount = criticalTasks.length;
  const { blocking: blockingCritical, synthetic: syntheticCritical } = partitionCriticalTasks(criticalTasks);
  const selfHealPending = blockingCritical.length > 0;
  const criticalIncidentSummary = {
    criticalCount,
    blockingCriticalCount: blockingCritical.length,
    syntheticCriticalCount: syntheticCritical.length,
    selfHealPending,
    topCriticalTasks: blockingCritical.slice(0, 5).map((t) => ({
      id: t.id,
      incidentCode: t.incidentCode,
      symbol: t.symbol,
      detail: t.detail,
      createdAt: t.createdAt,
    })),
  };

  const activeAdaptiveActions = getActiveActions(adaptiveState);
  const baseConfig = getGuardrailConfig();
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

  return NextResponse.json({
    ok: true,
    strategist,
    criticalIncidentSummary,
    manualQueueSummary: {
      openCount: manualCounts.openCount,
      executionReadyCount: manualCounts.executionReadyCount,
      topManualTasks: manualTasks
        .filter((t) => t.status === "OPEN" || t.status === "SELECTED" || t.status === "IN_PROGRESS")
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          taskType: t.taskType,
          status: t.status,
          executionReady: t.executionReady,
          createdAt: t.createdAt,
        })),
    },
    emBrief: emBrief
      ? {
          id: emBrief.id,
          createdAt: emBrief.createdAt,
          selectedTaskTitle: emBrief.selectedTaskTitle,
          strategistBias: emBrief.strategistBias,
          learningSignalsSummary: emBrief.learningSignalsSummary,
          rationale: emBrief.rationale,
          topTasks: emBrief.scoredTasks.slice(0, 5).map((t) => ({
            title: t.title,
            priorityBucket: t.priorityBucket,
            priorityScore: t.priorityScore,
          })),
        }
      : null,
    // Phase 4: Adaptive guardrails & execution autonomy
    adaptiveGuardrails: {
      activeActionCount: activeAdaptiveActions.length,
      lastEvaluatedAt: adaptiveState.lastEvaluatedAt,
      activeActions: activeAdaptiveActions.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        reason: a.reason,
        triggerPattern: a.triggerPattern,
        appliedAt: a.appliedAt,
        expiresAt: a.expiresAt,
        appliedValue: a.appliedValue,
      })),
      effectiveOverrides: {
        maxOpenPositions: getEffectiveMaxOpenPositions(baseConfig.maxOpenPositions, activeAdaptiveActions),
        maxEntriesPerDay: getEffectiveMaxEntriesPerDay(baseConfig.maxEntriesPerDay, activeAdaptiveActions),
        minScoreAdjustment: getEffectiveMinScoreAdjustment(0, activeAdaptiveActions),
        cooldownAfterLossMin: getEffectiveCooldownAfterLoss(baseConfig.cooldownAfterLossMin, activeAdaptiveActions),
        suppressedSides: getSuppressedSides(activeAdaptiveActions),
      },
    },
    executionAutonomy: {
      executionReadyTaskCount: executionReadyTasks.length,
      patchCapable: ghCapability.writeEnabled,
      repoWriteAvailable: ghCapability.writeEnabled,
      repoWriteReason: ghCapability.reason ?? null,
      latestExecutionResult: latestExec ? {
        executionStatus: latestExec.executionStatus ?? null,
        selectedTaskId: latestExec.selectedTaskId ?? null,
        selectedTaskTitle: latestExec.selectedTaskTitle ?? null,
        patchApplied: latestExec.patchApplied ?? false,
        commitSha: latestExec.commitSha ?? null,
      } : null,
    },
  });
}
