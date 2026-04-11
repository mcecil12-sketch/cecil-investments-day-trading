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
    return NextResponse.json({
      ok: true,
      fresh: true,
      critical: criticalEntries.length,
      unresolvedCriticalCount: criticalTasks.length,
      blockingCriticalCount: blocking.length,
      syntheticCriticalCount: synthetic.length,
      selfHealPending: blocking.length > 0,
      criticalTasks: criticalEntries,
      selectedTaskId: result.selectedTaskId,
      selectedTaskTitle: result.selectedTaskTitle,
      strategistBias: result.strategist.marketBias,
      scoredTasks: result.scoredTasks,
    });
  }

  const brief = await readEmBrief().catch(() => null);
  if (!brief) {
    return NextResponse.json({ ok: true, fresh: false, scoredTasks: [], message: "No priorities computed yet. POST /api/agents/run to initialize." });
  }

  const [criticalTasks, adaptiveState, tasks, latestExecRaw] = await Promise.all([
    getCriticalTasks().catch(() => []),
    readAdaptiveGuardrailState().catch(() => ({ actions: [], lastEvaluatedAt: null, evaluationSource: null })),
    listEngineeringTasks(100).catch(() => []),
    redis ? redis.get<string>(AGENT_LATEST_EXECUTION_KEY).catch(() => null) : Promise.resolve(null),
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

  return NextResponse.json({
    ok: true,
    fresh: false,
    id: brief.id,
    createdAt: brief.createdAt,
    selectedTaskId: selfHealPending ? criticalEntries[0]?.taskId ?? brief.selectedTaskId : brief.selectedTaskId,
    selectedTaskTitle: selfHealPending ? criticalEntries[0]?.title ?? brief.selectedTaskTitle : brief.selectedTaskTitle,
    strategistBias: brief.strategistBias,
    learningSignalsSummary: brief.learningSignalsSummary,
    critical: blockingCritical.length,
    unresolvedCriticalCount: criticalTasks.length,
    blockingCriticalCount: blockingCritical.length,
    syntheticCriticalCount: syntheticCritical.length,
    selfHealPending,
    criticalTasks: criticalEntries,
    scoredTasks: brief.scoredTasks,
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
