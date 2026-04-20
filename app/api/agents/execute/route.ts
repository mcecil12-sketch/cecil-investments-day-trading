export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { prepareExecutionPlan } from "@/lib/agents/execution/engine";
import { executeGithubTask } from "@/lib/agents/githubExecutor";
import { approveExecution } from "@/lib/agents/governance/manager";
import { listEngineeringTasks, updateEngineeringTaskById } from "@/lib/agents/store";
import { openImpactEnvelope, closeImpactEnvelope } from "@/lib/agents/executionImpact";
import { runSmokeValidation } from "@/lib/agents/preCommitValidation";
import { getCriticalTasks, partitionCriticalTasks, expireSyntheticTask } from "@/lib/redis";
import { redis } from "@/lib/redis";
import { runSafeExecutionGate, type GateResult } from "@/lib/agents/safe-execution-gate";
import { resolveWithVerification, setAttemptMetadata, resolveAsStale } from "@/lib/agents/incident-resolution";
import { runIncidentResolver, type ActionResult } from "@/lib/agents/resolvers";
import { generatePatchPlan, classifyTaskAsActionable } from "@/lib/agents/patch-executor";
import { checkGitHubWriteCapability } from "@/lib/agents/github-write";
import { runStructuredVerification } from "@/lib/agents/verification-runner";
import { evaluateAdaptiveGuardrails } from "@/lib/agents/adaptiveGuardrails";
import { AGENT_LATEST_EXECUTION_KEY } from "@/lib/agents/keys";
import { runLearningAnalysis } from "@/lib/agents/learning-detectors";
import { applyOneRemediation, checkPendingRemediations } from "@/lib/agents/learning-remediation";
import { getLedgerSummary, recordLedgerEntry } from "@/lib/agents/learning-ledger";
import {
  peekNextManualActionTask,
  claimNextManualActionTask,
  startManualActionTask,
  completeManualActionTask,
  blockManualActionTask,
  failManualActionTask,
  countOpenExecutionReadyManualTasks,
  recoverStaleManualTasks,
  recoverBlockedTasksWithFallbackHints,
  getActiveManualTask,
  cleanupFailedTasks,
  type ManualActionTask,
  type StaleRecoveryResult,
  type FailedTaskCleanupResult,
  type BlockedTaskRecoveryResult,
} from "@/lib/agents/manual-action-queue";
import { executeManualTask } from "@/lib/agents/manual-task-executor";
import { mapIncidentsToTasks } from "@/lib/agents/critical-incident-mapper";
import { createTasksFromIncidents, type FunnelIncident } from "@/lib/agents/incident-task-bridge";
import { auditProtectionIntegrity } from "@/lib/risk/protection-integrity";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { readTrades } from "@/lib/tradesStore";
import { isOpenTradeStatus } from "@/lib/trades/protection";
import type {
  EngineeringTask,
  ExecutionPhase,
  ExecutionPhaseResult,
  ExecutionStateMachineResult,
  PatchPlanDetail,
} from "@/lib/agents/types";

// ─── Helper: resolve base URL for internal API calls ────────────────

function resolveExecuteBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

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
    task.status === "READY_FOR_EXECUTION"
  );
}

function executionSortRank(task: EngineeringTask): number {
  return task.status === "READY_FOR_EXECUTION"
    ? 0
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

function buildReadyExecutionTask(task: EngineeringTask, updates?: Partial<EngineeringTask>): EngineeringTask {
  return {
    ...task,
    ...updates,
    status: "READY_FOR_EXECUTION",
  };
}

// ─── Phase tracking helpers ─────────────────────────────────────────

function phaseResult(
  phase: ExecutionPhase,
  status: ExecutionPhaseResult["status"],
  detail?: string,
  startMs?: number,
): ExecutionPhaseResult {
  return {
    phase,
    status,
    durationMs: startMs ? Date.now() - startMs : undefined,
    detail,
  };
}

async function storeLatestExecution(result: Record<string, unknown>): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(AGENT_LATEST_EXECUTION_KEY, JSON.stringify(result), { ex: 86400 * 7 });
  } catch {
    // non-fatal
  }
}

/** Build learning/remediation block for execute responses (returns null-safe object). */
function buildLearningBlock(
  learningResult: Awaited<ReturnType<typeof runLearningAnalysis>> | null,
  remediationResult: { applied: boolean; reason: string } | null,
  verificationResult: { checked: number; rolledBack: number; verified: number } | null,
  ledgerSummary: { openRemediations: number; pendingVerifications: number; recentRollbacks: number; lastEntryAt: string | null } | null,
) {
  return {
    learning: learningResult
      ? {
          findingsCount: learningResult.findings.length,
          highSeverityCount: learningResult.findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH").length,
          findings: learningResult.findings.map((f) => ({ id: f.id, category: f.category, severity: f.severity, suggestedAction: f.suggestedAction })),
        }
      : null,
    remediation: remediationResult ?? null,
    verificationCheck: verificationResult ?? null,
    ledger: ledgerSummary
      ? {
          openRemediations: ledgerSummary.openRemediations,
          pendingVerifications: ledgerSummary.pendingVerifications,
          recentRollbacks: ledgerSummary.recentRollbacks,
          lastEntryAt: ledgerSummary.lastEntryAt,
        }
      : null,
  };
}

// ─── GitHub commit execution (preserved from Phase 3) ───────────────

async function executeReadyForGithubCommit(
  task: EngineeringTask,
  phases: ExecutionPhaseResult[],
  dryRun: boolean,
): Promise<{ response: NextResponse; phases: ExecutionPhaseResult[]; commitSha?: string }> {

  // APPLY_PATCH phase
  const applyStart = Date.now();

  if (dryRun) {
    phases.push(phaseResult("APPLY_PATCH", "skipped", "dry_run", applyStart));
    phases.push(phaseResult("COMMIT_PUSH", "skipped", "dry_run"));
    phases.push(phaseResult("VERIFY", "skipped", "dry_run"));
    phases.push(phaseResult("RESOLVE_OR_FAIL", "skipped", "dry_run"));
    return {
      response: NextResponse.json({
        ok: true,
        dryRun: true,
        executedTaskId: task.id,
        executionStatus: "DRY_RUN",
        patchPlan: generatePatchPlan(task),
        message: "Dry run — no changes applied",
        executionPhases: phases,
      }),
      phases,
    };
  }

  // Phase 3: open impact envelope before execution
  let envelopeId: string | null = null;
  try {
    const envelope = await openImpactEnvelope(task.id, "engineering");
    envelopeId = envelope.envelopeId;
  } catch {
    // non-fatal — impact tracking is best-effort
  }

  // Phase 3: run smoke validation before committing
  let validationPassed = true;
  let validationFailureReason: string | null = null;
  try {
    const validation = await runSmokeValidation(task);
    validationPassed = validation.passed;
    validationFailureReason = validation.failureReason;
    if (!validationPassed) {
      console.warn(`[AGENT-EXECUTE] Pre-commit smoke validation failed for task ${task.id}: ${validationFailureReason}`);
    }
  } catch {
    // non-fatal — validation errors don't block execution
  }

  if (!validationPassed && validationFailureReason) {
    const blockedNotes = appendNotes(task.notes, [
      `Pre-commit validation failed: ${validationFailureReason}`,
      "Proceeding with execution — smoke check failure is advisory.",
    ]);
    await updateEngineeringTaskById(task.id, { notes: blockedNotes });
  }

  const executionResult = await executeGithubTask(task);
  phases.push(phaseResult("APPLY_PATCH", "passed", `files: ${executionResult.filesTouched.join(", ")}`, applyStart));

  // COMMIT_PUSH phase
  const commitStart = Date.now();
  phases.push(phaseResult("COMMIT_PUSH", "passed", executionResult.commitSha ?? "no_sha", commitStart));

  await updateEngineeringTaskById(task.id, {
    status: "DONE",
    remediationAttempted: true,
    remediationStatus: "completed",
    remediationResultSummary: `Executed via GitHub contents API (${executionResult.filesTouched.join(", ")}).`,
    executionStatus: "EXECUTED",
    executionError: null,
    commitSha: executionResult.commitSha ?? null,
    commitUrl: executionResult.commitUrl ?? null,
    linkedTelemetrySnapshot: {
      executionCommitSha: executionResult.commitSha ?? null,
      executionCommitUrl: executionResult.commitUrl ?? null,
      executionFilesTouched: executionResult.filesTouched,
    },
    notes: appendNotes(task.notes, [
      "Executed via GitHub contents API",
      `Commit message: ${executionResult.commitMessage}`,
      executionResult.commitSha ? `Commit sha: ${executionResult.commitSha}` : "",
      executionResult.commitUrl ? `Commit url: ${executionResult.commitUrl}` : "",
    ]),
  });

  // VERIFY phase
  const verifyStart = Date.now();
  let verification = { buildOk: true, smokeOk: true, details: {} as Record<string, unknown> };
  try {
    const vResult = await runStructuredVerification(task);
    verification = {
      buildOk: vResult.gateResult.buildOk,
      smokeOk: vResult.gateResult.smokeOk,
      details: {
        probes: vResult.probeResults,
        taskSpecific: vResult.taskSpecificResults,
      },
    };
    phases.push(phaseResult("VERIFY", vResult.overall ? "passed" : "failed", vResult.gateResult.failureReason ?? undefined, verifyStart));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    phases.push(phaseResult("VERIFY", "failed", msg, verifyStart));
    verification = { buildOk: false, smokeOk: false, details: { error: msg } };
  }

  // RESOLVE_OR_FAIL phase
  const resolveStart = Date.now();
  const verificationPassed = verification.buildOk && verification.smokeOk;
  if (verificationPassed) {
    phases.push(phaseResult("RESOLVE_OR_FAIL", "passed", "verified_and_resolved", resolveStart));
  } else {
    // Mark task as needing attention but don't revert the commit
    await updateEngineeringTaskById(task.id, {
      notes: appendNotes(task.notes, [`Post-commit verification failed: ${JSON.stringify(verification.details)}`]),
    });
    phases.push(phaseResult("RESOLVE_OR_FAIL", "failed", "verification_failed_post_commit", resolveStart));
  }

  // Phase 3: close impact envelope after execution
  if (envelopeId) {
    try {
      await closeImpactEnvelope(envelopeId, executionResult.commitSha ?? null);
    } catch {
      // non-fatal
    }
  }

  return {
    response: NextResponse.json({
      ok: true,
      executedTaskId: task.id,
      executionStatus: verificationPassed ? "COMPLETED" : "EXECUTED_UNVERIFIED",
      selectedSource: "engineering-backlog",
      selectedTaskId: task.id,
      selectedTaskTitle: task.title,
      filesTouched: executionResult.filesTouched,
      commitMessage: executionResult.commitMessage,
      commitSha: executionResult.commitSha,
      commitUrl: executionResult.commitUrl,
      branchName: task.commitPlan?.targetBranch ?? "main",
      patchApplied: true,
      verification,
      resolution: {
        resolved: verificationPassed,
        reason: verificationPassed ? undefined : "post_commit_verification_failed",
      },
      executionPhases: phases,
    }),
    phases,
    commitSha: executionResult.commitSha ?? undefined,
  };
}

async function blockExecution(task: EngineeringTask, message: string) {
  await updateEngineeringTaskById(task.id, {
    status: "BLOCKED",
    remediationAttempted: true,
    remediationStatus: "failed",
    remediationResultSummary: `Execution failed: ${message}`,
    executionStatus: "FAILED",
    executionError: message,
    notes: appendNotes(task.notes, [`Execution failed: ${message}`]),
  });
}

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  // ─── Dry-run detection ──────────────────────────────────────────────
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dry_run") === "1";

  let task: EngineeringTask | null = null;
  const phases: ExecutionPhaseResult[] = [];

  // ─── Proactive Diagnostics Tracking ────────────────────────────────
  // Track whether proactive checks ran and what they found
  const proactiveDiagnostics: {
    criticalTasksChecked: boolean;
    criticalTasksFound: number;
    criticalTasksBlocking: number;
    manualQueueChecked: boolean;
    manualQueueActiveTask: string | null;
    staleRecoveryAttempted: boolean;
    staleRecoveryCount: number;
    executionPathTaken: string;
    proactiveEscalation: {
      attempted: boolean;
      auditOk: boolean | null;
      criticalDetected: number;
      escalatedCount: number;
      escalationError: string | null;
    } | null;
    funnelIncidentBridge: {
      attempted: boolean;
      incidentsDetected: number;
      tasksCreated: number;
      tasksDeduplicated: number;
      error: string | null;
    } | null;
  } = {
    criticalTasksChecked: false,
    criticalTasksFound: 0,
    criticalTasksBlocking: 0,
    manualQueueChecked: false,
    manualQueueActiveTask: null,
    staleRecoveryAttempted: false,
    staleRecoveryCount: 0,
    executionPathTaken: "unknown",
    proactiveEscalation: null,
    funnelIncidentBridge: null,
  };

  try {
    // ─── Adaptive Guardrails Evaluation ─────────────────────────────
    // Run performance-learning evaluation before task selection
    // dryRun: skip entirely — evaluateAdaptiveGuardrails may apply actions
    let adaptiveResult = null;
    if (!dryRun) {
      try {
        adaptiveResult = await evaluateAdaptiveGuardrails();
        if (adaptiveResult.actionsApplied.length > 0 || adaptiveResult.tasksCreated.length > 0) {
          console.log(`[AGENT-EXECUTE] Adaptive guardrails: ${adaptiveResult.actionsApplied.length} actions applied, ${adaptiveResult.tasksCreated.length} tasks created`);
        }
      } catch (err) {
        console.warn("[AGENT-EXECUTE] Adaptive guardrails evaluation failed (non-fatal):", err);
      }
    }

    // ─── Proactive Protection Incident Escalation ─────────────────────
    // Ensure CRITICAL protection incidents are escalated to the critical
    // task queue even if the ops agent hasn't run. This is a fallback to
    // guarantee the execute loop can act on missing stop protection, etc.
    let proactiveEscalation: {
      attempted: boolean;
      auditOk: boolean | null;
      criticalDetected: number;
      escalatedCount: number;
      escalationError: string | null;
    } = {
      attempted: false,
      auditOk: null,
      criticalDetected: 0,
      escalatedCount: 0,
      escalationError: null,
    };

    if (!dryRun) {
      try {
        proactiveEscalation.attempted = true;
        const brokerTruth = await fetchBrokerTruth();
        if (!brokerTruth.error) {
          const allTrades = await readTrades<any>().catch(() => []);
          const openTrades = (Array.isArray(allTrades) ? allTrades : [])
            .filter((t) => isOpenTradeStatus(t?.status))
            .map((t: any) => ({
              id: String(t.id || ""),
              ticker: String(t.ticker || ""),
              side: String(t.side || ""),
              status: String(t.status || ""),
              qty: Number(t.size || t.qty || 0),
              stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
              protectionStatus: t.protectionStatus,
            }));

          const protectionAudit = auditProtectionIntegrity({
            openTrades,
            brokerPositions: brokerTruth.positions || [],
            brokerOrders: brokerTruth.openOrders || [],
          });

          proactiveEscalation.auditOk = protectionAudit.ok;

          if (!protectionAudit.ok && protectionAudit.criticalCount > 0) {
            const criticalIncidents = protectionAudit.incidents.filter(
              (i) => i.severity === "CRITICAL"
            );
            proactiveEscalation.criticalDetected = criticalIncidents.length;

            // Escalate to critical task queue (deduped by date)
            const escalatedTasks = await mapIncidentsToTasks(criticalIncidents);
            proactiveEscalation.escalatedCount = escalatedTasks.length;

            if (escalatedTasks.length > 0) {
              console.log(`[AGENT-EXECUTE] Proactive escalation: ${escalatedTasks.length} CRITICAL protection incident(s) -> critical queue: ${criticalIncidents.map((i) => `${i.symbol}:${i.code}`).join(", ")}`);
            }
          }
        } else {
          proactiveEscalation.escalationError = "broker_truth_error";
        }
      } catch (err) {
        proactiveEscalation.escalationError = err instanceof Error ? err.message : String(err);
        console.warn("[AGENT-EXECUTE] Proactive escalation check failed (non-fatal):", err);
      }
      
      // Always capture escalation diagnostics after the check completes
      proactiveDiagnostics.proactiveEscalation = proactiveEscalation;
    }

    // ─── Proactive Funnel Incident Escalation ─────────────────────────
    // Bridge funnel-health incidents (UNDERUTILIZED_FUNNEL, QUALIFIED_NOT_SEEDED,
    // etc.) into ManualActionTasks so executionReadyCount reflects available work.
    // This ensures the manual queue has actionable tasks for HIGH/CRITICAL incidents.
    let funnelIncidentBridge: {
      attempted: boolean;
      incidentsDetected: number;
      tasksCreated: number;
      tasksDeduplicated: number;
      error: string | null;
    } | null = null;

    if (!dryRun) {
      try {
        // Fetch funnel-health to detect current incidents
        const baseUrl = resolveExecuteBaseUrl();
        const funnelRes = await fetch(`${baseUrl}/api/funnel-health`, {
          headers: { "cache-control": "no-store" },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);

        if (funnelRes && funnelRes.ok) {
          const funnelData = await funnelRes.json().catch(() => null);
          const funnelIncidents: FunnelIncident[] = funnelData?.incidents ?? [];

          // Only process HIGH and CRITICAL incidents
          const actionableIncidents = funnelIncidents.filter(
            (i) => i.severity === "CRITICAL" || i.severity === "HIGH"
          );

          funnelIncidentBridge = {
            attempted: true,
            incidentsDetected: actionableIncidents.length,
            tasksCreated: 0,
            tasksDeduplicated: 0,
            error: null,
          };

          if (actionableIncidents.length > 0) {
            const bridgeResult = await createTasksFromIncidents(actionableIncidents);
            funnelIncidentBridge.tasksCreated = bridgeResult.createdCount;
            funnelIncidentBridge.tasksDeduplicated = bridgeResult.dedupedCount;

            if (bridgeResult.createdCount > 0) {
              console.log(
                `[AGENT-EXECUTE] Funnel incident bridge: ${bridgeResult.createdCount} tasks created from ${actionableIncidents.length} incidents: ` +
                actionableIncidents.map((i) => i.code).join(", ")
              );
            }
          }
        }
      } catch (err) {
        funnelIncidentBridge = {
          attempted: true,
          incidentsDetected: 0,
          tasksCreated: 0,
          tasksDeduplicated: 0,
          error: err instanceof Error ? err.message : String(err),
        };
        console.warn("[AGENT-EXECUTE] Funnel incident bridge failed (non-fatal):", err);
      }

      // Capture funnel incident bridge diagnostics
      proactiveDiagnostics.funnelIncidentBridge = funnelIncidentBridge;
    }

    // ─── Critical Task Batch Drain ────────────────────────────────────
    // When unresolved protection incidents exist, attempt to resolve all
    // eligible critical tasks in one run (capped for safety).
    // Synthetic (drill) tasks are auto-expired if they fail — they have no
    // broker-side positions to repair.
    const criticalTasks = await getCriticalTasks().catch(() => []);
    const { blocking: blockingCritical, synthetic: syntheticCritical } = partitionCriticalTasks(criticalTasks);
    
    // Update proactive diagnostics
    proactiveDiagnostics.criticalTasksChecked = true;
    proactiveDiagnostics.criticalTasksFound = criticalTasks.length;
    proactiveDiagnostics.criticalTasksBlocking = blockingCritical.length;

    // Auto-expire synthetic drill tasks — they never have real broker state
    if (!dryRun) {
      for (const st of syntheticCritical) {
        await expireSyntheticTask(st.id, "auto_expired_synthetic_drill").catch(() => {});
      }
    }

    if (blockingCritical.length > 0) {
      proactiveDiagnostics.executionPathTaken = "critical_task_resolution";
      // ─── DRY RUN: preview critical batch, ZERO mutations ──────────
      if (dryRun) {
        return NextResponse.json({
          ok: true,
          dryRun: true,
          executionStatus: "CRITICAL_BATCH_DRY_RUN",
          selectedSource: "critical-task-queue",
          patchApplied: false,
          commitSha: null,
          criticalTaskCount: blockingCritical.length,
          syntheticCount: syntheticCritical.length,
          proactiveDiagnostics,
          blockingTasks: blockingCritical.map((ct) => ({
            id: ct.id,
            incidentCode: ct.incidentCode,
            symbol: ct.symbol,
            severity: ct.severity,
          })),
          executionPhases: [
            phaseResult("SELECT_TASK", "passed", "critical_queue_dry_run"),
            phaseResult("APPLY_PATCH", "skipped", "dry_run"),
            phaseResult("VERIFY", "skipped", "dry_run"),
            phaseResult("RESOLVE_OR_FAIL", "skipped", "dry_run"),
          ],
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: "dry_run" },
        });
      }

      const MAX_PER_RUN = Math.max(1, Math.min(20, Number(process.env.MAX_CRITICAL_RESOLUTIONS_PER_RUN) || 5));
      const batch = blockingCritical.slice(0, MAX_PER_RUN);

      console.log(`[AGENT-EXECUTE] Critical batch start: ${batch.length}/${blockingCritical.length} blocking tasks (${syntheticCritical.length} synthetic auto-expired), cap=${MAX_PER_RUN}`);

      // Run safe execution gate once for the batch (build + smoke validation)
      let gateResult: GateResult | null = null;
      try {
        gateResult = await runSafeExecutionGate(batch[0]);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        gateResult = {
          passed: false,
          buildOk: false,
          buildProbe: { route: "/api/agents/state", ok: false, status: null, reason: errMsg },
          smokeOk: false,
          smokeProbes: [],
          validatedAt: new Date().toISOString(),
          failureReason: `gate_exception: ${errMsg}`,
          baseUrl: "unknown",
          authMode: "unknown",
        };
      }

      // If gate fails, block the entire batch
      if (!gateResult.passed) {
        for (const ct of batch) {
          await setAttemptMetadata(ct.id, {
            lastAttemptAt: new Date().toISOString(),
            lastAttemptResult: "failure",
            lastVerificationResult: "skipped",
            lastVerificationReason: gateResult.failureReason ?? "gate_failed",
          }).catch(() => {});
        }

        const result = {
          ok: true,
          message: "Execution blocked: safe execution gate failed",
          criticalBypassApplied: true,
          selectedSource: "critical-task-queue",
          executionStatus: "BYPASSED_CRITICAL",
          selectedTaskId: batch[0]?.id ?? null,
          selectedTaskTitle: batch[0] ? `[CRITICAL] ${batch[0].incidentCode}: ${batch[0].symbol}` : null,
          criticalTaskCount: blockingCritical.length,
          syntheticExpiredCount: syntheticCritical.length,
          attemptedCriticalCount: 0,
          resolvedCriticalCount: 0,
          failedCriticalCount: 0,
          skippedCriticalCount: batch.length,
          remainingCriticalCount: blockingCritical.length,
          criticalResolutionResults: batch.map((ct) => ({
            id: ct.id,
            incidentCode: ct.incidentCode,
            symbol: ct.symbol,
            status: "skipped" as const,
            reason: gateResult!.failureReason ?? "gate_failed",
          })),
          safeExecutionGate: gateResult,
          executionPhases: [phaseResult("SELECT_TASK", "passed", "critical_queue")],
          patchApplied: false,
          verification: { buildOk: gateResult.buildOk, smokeOk: gateResult.smokeOk, details: {} },
          resolution: { resolved: false, reason: "gate_failed" },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
        };
        await storeLatestExecution(result);
        return NextResponse.json(result);
      }

      // Gate passed — attempt resolution for each task
      type ItemResult = {
        id: string;
        incidentCode: string;
        symbol: string;
        status: "resolved" | "failed" | "skipped" | "stale_resolved" | "expired";
        reason: string | null;
        action?: ActionResult;
      };
      const results: ItemResult[] = [];
      let resolvedCount = 0;
      let failedCount = 0;
      let staleResolvedCount = 0;

      for (const ct of batch) {
        try {
          const actionResult = await runIncidentResolver(ct);
          console.log(`[AGENT-EXECUTE] resolver result for ${ct.id}:`, {
            action: actionResult.action,
            ok: actionResult.ok,
            attempted: actionResult.attempted,
            reasonCode: actionResult.reasonCode,
          });

          if (actionResult.attempted && !actionResult.ok) {
            // Check if this is a stale/non-actionable incident
            if (actionResult.reasonCode === "no_broker_position") {
              const staleResult = await resolveAsStale(
                ct.id,
                ct.symbol,
                "stale_unactionable_no_broker_position",
              );
              if (staleResult.resolved) {
                staleResolvedCount++;
                results.push({
                  id: ct.id,
                  incidentCode: ct.incidentCode,
                  symbol: ct.symbol,
                  status: "stale_resolved",
                  reason: "stale_unactionable_no_broker_position",
                  action: actionResult,
                });
                continue;
              }
            }

            failedCount++;
            await setAttemptMetadata(ct.id, {
              lastAttemptAt: new Date().toISOString(),
              lastAttemptResult: "failure",
              lastVerificationResult: "skipped",
              lastVerificationReason: actionResult.detail,
            }).catch(() => {});
            results.push({
              id: ct.id,
              incidentCode: ct.incidentCode,
              symbol: ct.symbol,
              status: "failed",
              reason: actionResult.detail,
              action: actionResult,
            });
            continue;
          }

          const res = await resolveWithVerification(ct.id);
          if (res.resolved) {
            resolvedCount++;
            results.push({
              id: ct.id,
              incidentCode: ct.incidentCode,
              symbol: ct.symbol,
              status: "resolved",
              reason: null,
              action: actionResult,
            });
          } else {
            failedCount++;
            results.push({
              id: ct.id,
              incidentCode: ct.incidentCode,
              symbol: ct.symbol,
              status: "failed",
              reason: res.verification.reason,
              action: actionResult,
            });
          }
        } catch (err) {
          failedCount++;
          results.push({ id: ct.id, incidentCode: ct.incidentCode, symbol: ct.symbol, status: "failed", reason: err instanceof Error ? err.message : String(err) });
        }
      }

      const remainingCount = blockingCritical.length - resolvedCount - staleResolvedCount;
      const allResolved = remainingCount <= 0;

      console.log(`[AGENT-EXECUTE] Critical batch done: resolved=${resolvedCount} stale=${staleResolvedCount} failed=${failedCount} remaining=${remainingCount}`);

      const critResult = {
        ok: true,
        message: allResolved
          ? staleResolvedCount > 0 && resolvedCount === 0
            ? "All critical incidents auto-resolved as stale/non-actionable — autonomy unblocked"
            : "All critical incidents resolved after verification"
          : `Resolved ${resolvedCount + staleResolvedCount}/${batch.length} critical incidents`,
        criticalBypassApplied: !allResolved,
        selectedSource: "critical-task-queue",
        executionStatus: allResolved ? "CRITICAL_BATCH_RESOLVED" : resolvedCount + staleResolvedCount > 0 ? "CRITICAL_BATCH_PARTIAL" : "BYPASSED_CRITICAL",
        selectedTaskId: batch[0]?.id ?? null,
        selectedTaskTitle: batch[0] ? `[CRITICAL] ${batch[0].incidentCode}: ${batch[0].symbol}` : null,
        criticalTaskCount: blockingCritical.length,
        syntheticExpiredCount: syntheticCritical.length,
        attemptedCriticalCount: batch.length,
        resolvedCriticalCount: resolvedCount,
        staleResolvedCriticalCount: staleResolvedCount,
        failedCriticalCount: failedCount,
        skippedCriticalCount: 0,
        remainingCriticalCount: remainingCount,
        criticalResolutionResults: results,
        safeExecutionGate: gateResult,
        executionPhases: [
          phaseResult("SELECT_TASK", "passed", "critical_queue"),
          phaseResult("APPLY_PATCH", resolvedCount + staleResolvedCount > 0 ? "passed" : "failed", `resolved ${resolvedCount}/${batch.length} stale ${staleResolvedCount}`),
          phaseResult("VERIFY", "passed", "gate_passed"),
          phaseResult("RESOLVE_OR_FAIL", allResolved ? "passed" : "failed", `remaining: ${remainingCount}`),
        ],
        patchApplied: resolvedCount > 0,
        verification: { buildOk: gateResult.buildOk, smokeOk: gateResult.smokeOk, details: {} },
        resolution: { resolved: allResolved, reason: allResolved ? undefined : `${remainingCount} tasks remaining` },
        adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
      };
      await storeLatestExecution(critResult);
      return NextResponse.json(critResult);
    }

    // ─── Manual Queue Execution (priority B) ─────────────────────────
    // After critical incidents are resolved, check for execution-ready
    // manual queue tasks before falling through to autonomous backlog.
    // Lifecycle: SELECT -> CLAIM -> APPLY PATCH -> VERIFY -> RESOLVE/FAIL

    // Step 1: Recover stale tasks BEFORE any active-task detection.
    // In dryRun, preview only (no mutations). In real mode, mutate then reload.
    let staleRecovery: StaleRecoveryResult;
    try {
      staleRecovery = await recoverStaleManualTasks(dryRun);
      if (staleRecovery.recoveredCount > 0 || staleRecovery.recovered.length > 0) {
        console.log(
          `[AGENT-EXECUTE] Stale recovery (dryRun=${dryRun}): ${staleRecovery.recoveredCount} tasks recovered, ` +
          `candidates=${staleRecovery.recovered.length} failedIds=[${staleRecovery.failedTaskIds}] releasedIds=[${staleRecovery.releasedTaskIds}]`,
        );
      }
    } catch (err) {
      console.warn("[AGENT-EXECUTE] Stale recovery failed (non-fatal):", err);
      staleRecovery = { attempted: true, recoveredCount: 0, recovered: [], recoveredTaskIds: [], failedTaskIds: [], releasedTaskIds: [], reasonCodes: [] };
    }

    // Step 1b: Cleanup old FAILED/BLOCKED tasks to prevent queue from wedging.
    // This runs periodically to archive tasks that are unrecoverable.
    let failedTaskCleanup: FailedTaskCleanupResult | null = null;
    if (!dryRun) {
      try {
        failedTaskCleanup = await cleanupFailedTasks(false);
        if (failedTaskCleanup.archivedCount > 0) {
          console.log(`[AGENT-EXECUTE] Archived ${failedTaskCleanup.archivedCount} old FAILED/BLOCKED tasks: [${failedTaskCleanup.archivedTaskIds}]`);
        }
      } catch (err) {
        console.warn("[AGENT-EXECUTE] Failed task cleanup failed (non-fatal):", err);
      }
    }

    // Step 1c: Recover BLOCKED tasks with fallback hints.
    // This unblocks tasks that were BLOCKED with no_file_hints by applying
    // fallback hints based on their taskType.
    let blockedRecovery: BlockedTaskRecoveryResult | null = null;
    try {
      blockedRecovery = await recoverBlockedTasksWithFallbackHints(dryRun);
      if (blockedRecovery.recoveredCount > 0) {
        console.log(
          `[AGENT-EXECUTE] Blocked task recovery (dryRun=${dryRun}): ${blockedRecovery.recoveredCount} tasks unblocked, ` +
          `${blockedRecovery.enrichedCount} enriched, recovered=[${blockedRecovery.recoveredTaskIds}]`,
        );
      }
    } catch (err) {
      console.warn("[AGENT-EXECUTE] Blocked task recovery failed (non-fatal):", err);
      blockedRecovery = { attempted: true, recoveredCount: 0, enrichedCount: 0, candidates: [], recoveredTaskIds: [], enrichedTaskIds: [], skippedTaskIds: [] };
    }

    // Update proactive diagnostics
    proactiveDiagnostics.staleRecoveryAttempted = staleRecovery.attempted;
    proactiveDiagnostics.staleRecoveryCount = staleRecovery.recoveredCount;
    // Add blocked recovery diagnostics
    (proactiveDiagnostics as Record<string, unknown>).blockedRecoveryAttempted = blockedRecovery?.attempted ?? false;
    (proactiveDiagnostics as Record<string, unknown>).blockedRecoveryCount = blockedRecovery?.recoveredCount ?? 0;
    (proactiveDiagnostics as Record<string, unknown>).blockedRecoveryEnrichedCount = blockedRecovery?.enrichedCount ?? 0;

    // Step 2: RELOAD queue state from source of truth AFTER recovery.
    // This ensures counts and active-task reflect recovered state.
    const manualCounts = await countOpenExecutionReadyManualTasks().catch(() => ({
      openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0, selectedCount: 0,
      selectableCount: 0, recoverableBlockedCount: 0, idleReason: "count_fetch_failed" as string | null,
    }));
    const activeManualTask = await getActiveManualTask().catch(() => null);
    const hasActiveManualTask = activeManualTask !== null;
    // Use selectableCount for more precise work detection
    const hasManualWork = (manualCounts.selectableCount ?? manualCounts.executionReadyCount) > 0 || manualCounts.inProgressCount > 0 || manualCounts.selectedCount > 0;

    if (hasManualWork) {
      // ── DRY RUN: peek only, ZERO mutations ────────────────────────
      if (dryRun) {
        // For dry run, show either the active task or the next peeked task
        const dryRunTask = activeManualTask ?? await peekNextManualActionTask();
        const dryRunResult = {
          ok: true,
          dryRun: true,
          executionStatus: "MANUAL_TASK_DRY_RUN",
          selectedSource: "manual-action-queue",
          selectedTaskId: dryRunTask?.id ?? null,
          selectedTaskTitle: dryRunTask?.title ?? null,
          patchApplied: false,
          commitSha: null,
          manualTask: dryRunTask ? {
            id: dryRunTask.id,
            title: dryRunTask.title,
            description: dryRunTask.description,
            priority: dryRunTask.priority,
            taskType: dryRunTask.taskType,
            executionReady: dryRunTask.executionReady,
            status: dryRunTask.status,
            acceptanceCriteria: dryRunTask.acceptanceCriteria,
            fileHints: dryRunTask.fileHints,
            routeHints: dryRunTask.routeHints,
          } : null,
          manualQueueCounts: manualCounts,
          manualTaskStatus: dryRunTask?.status ?? null,
          staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
          executionPhases: [
            phaseResult("SELECT_TASK", "passed", dryRunTask ? "manual_queue_dry_run" : "no_manual_task_available"),
            phaseResult("CLAIM_TASK", "skipped", "dry_run"),
            phaseResult("APPLY_PATCH", "skipped", "dry_run"),
            phaseResult("VERIFY", "skipped", "dry_run"),
            phaseResult("RESOLVE_OR_FAIL", "skipped", "dry_run"),
          ],
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: "dry_run" },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
        };
        // dryRun: NO storeLatestExecution — zero mutations
        return NextResponse.json(dryRunResult);
      }

      // ── REAL EXECUTION: claim -> gate -> execute -> resolve ────────
      const manualTask = await claimNextManualActionTask();
      if (manualTask) {
        const manualPhases: ExecutionPhaseResult[] = [];
        manualPhases.push(phaseResult("SELECT_TASK", "passed", "manual_queue"));
        manualPhases.push(phaseResult("CLAIM_TASK", "passed", `claimed: ${manualTask.id}`));

        // Start: SELECTED -> IN_PROGRESS
        const startedTask = await startManualActionTask(manualTask.id);
        if (!startedTask) {
          manualPhases.push(phaseResult("CLAIM_TASK", "failed", "start_failed"));
          const failResult = {
            ok: false,
            executionStatus: "MANUAL_TASK_FAILED",
            selectedSource: "manual-action-queue",
            selectedTaskId: manualTask.id,
            selectedTaskTitle: manualTask.title,
            patchApplied: false,
            manualTaskStatus: "SELECTED",
            manualQueueCounts: manualCounts,
            staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
            executionPhases: manualPhases,
            verification: { buildOk: false, smokeOk: false, details: {} },
            resolution: { resolved: false, reason: "lifecycle_start_failed" },
            adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          };
          await storeLatestExecution(failResult);
          return NextResponse.json(failResult, { status: 500 });
        }

        // Run safe execution gate
        let manualGateResult: GateResult | null = null;
        try {
          manualGateResult = await runSafeExecutionGate({
            id: manualTask.id,
            incidentCode: "MANUAL_QUEUE",
            symbol: "SYSTEM",
            severity: manualTask.priority,
            detail: manualTask.title,
            createdAt: manualTask.createdAt,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          manualGateResult = {
            passed: false,
            buildOk: false,
            buildProbe: { route: "/api/agents/state", ok: false, status: null, reason: errMsg },
            smokeOk: false,
            smokeProbes: [],
            validatedAt: new Date().toISOString(),
            failureReason: `gate_exception: ${errMsg}`,
            baseUrl: "unknown",
            authMode: "unknown",
          };
        }

        if (manualGateResult && !manualGateResult.passed) {
          // Gate failed — block the manual task
          const blockedReason = manualGateResult.failureReason ?? "safe_execution_gate_failed";
          await blockManualActionTask(manualTask.id, blockedReason, {
            ok: false,
            summary: `Safe execution gate failed: ${blockedReason}`,
            error: blockedReason,
          });
          manualPhases.push(phaseResult("APPLY_PATCH", "failed", blockedReason));

          const blockedResult = {
            ok: true,
            message: "Manual queue task blocked: safe execution gate failed",
            executionStatus: "MANUAL_TASK_BLOCKED",
            selectedSource: "manual-action-queue",
            selectedTaskId: manualTask.id,
            selectedTaskTitle: manualTask.title,
            patchApplied: false,
            manualTaskStatus: "BLOCKED",
            safeExecutionGate: manualGateResult,
            manualQueueCounts: manualCounts,
            staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
            executionPhases: manualPhases,
            verification: { buildOk: manualGateResult.buildOk, smokeOk: manualGateResult.smokeOk, details: {} },
            resolution: { resolved: false, reason: "gate_failed" },
            adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          };
          await storeLatestExecution(blockedResult);
          return NextResponse.json(blockedResult);
        }

        // Gate passed — invoke manual task executor
        manualPhases.push(phaseResult("APPLY_PATCH", "passed", "gate_passed_invoking_executor"));

        let execResult;
        try {
          execResult = await executeManualTask(manualTask);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          execResult = {
            ok: false,
            patchApplied: false,
            blocked: false,
            summary: `Executor threw: ${errMsg}`,
            failureReason: errMsg,
          };
        }

        // Apply patch phase result
        manualPhases.push(phaseResult(
          "APPLY_PATCH",
          execResult.patchApplied ? "passed" : execResult.blocked ? "failed" : "failed",
          execResult.patchApplied
            ? `patch_applied: ${execResult.commitSha ?? "no_sha"}`
            : execResult.blockedReason ?? execResult.failureReason ?? "executor_failed",
        ));

        // Verify phase
        manualPhases.push(phaseResult(
          "VERIFY",
          execResult.ok ? "passed" : execResult.blocked ? "skipped" : "failed",
          execResult.ok
            ? "verification_passed"
            : execResult.blocked
              ? execResult.blockedReason ?? "blocked"
              : execResult.failureReason ?? "verification_failed",
        ));

        // Resolve or fail phase
        if (execResult.ok && execResult.patchApplied) {
          // SUCCESS — mark DONE
          await completeManualActionTask(manualTask.id, {
            ok: true,
            summary: execResult.summary,
            commitSha: execResult.commitSha,
            verification: execResult.verification as Record<string, unknown>,
          });
          manualPhases.push(phaseResult("RESOLVE_OR_FAIL", "passed", "completed"));

          const completedResult = {
            ok: true,
            executionStatus: "MANUAL_TASK_COMPLETED",
            selectedSource: "manual-action-queue",
            selectedTaskId: manualTask.id,
            selectedTaskTitle: manualTask.title,
            patchApplied: true,
            commitSha: execResult.commitSha ?? null,
            manualTaskStatus: "DONE",
            safeExecutionGate: manualGateResult,
            manualQueueCounts: manualCounts,
            staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
            executionPhases: manualPhases,
            verification: execResult.verification ?? { buildOk: true, smokeOk: true, details: {} },
            resolution: { resolved: true },
            adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          };
          await storeLatestExecution(completedResult);
          return NextResponse.json(completedResult);
        } else if (execResult.blocked) {
          // BLOCKED — executor couldn't run
          await blockManualActionTask(
            manualTask.id,
            execResult.blockedReason ?? "executor_blocked",
            {
              ok: false,
              summary: execResult.summary,
              error: execResult.blockedReason,
            },
          );
          manualPhases.push(phaseResult("RESOLVE_OR_FAIL", "failed", execResult.blockedReason ?? "blocked"));

          const blockedExecResult = {
            ok: false,
            executionStatus: "MANUAL_TASK_BLOCKED",
            selectedSource: "manual-action-queue",
            selectedTaskId: manualTask.id,
            selectedTaskTitle: manualTask.title,
            patchApplied: false,
            manualTaskStatus: "BLOCKED",
            safeExecutionGate: manualGateResult,
            manualQueueCounts: manualCounts,
            staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
            executionPhases: manualPhases,
            verification: execResult.verification ?? { buildOk: false, smokeOk: false, details: {} },
            resolution: { resolved: false, reason: execResult.blockedReason ?? "executor_blocked" },
            adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          };
          await storeLatestExecution(blockedExecResult);
          return NextResponse.json(blockedExecResult);
        } else {
          // FAILED — execution ran but didn't succeed
          await failManualActionTask(manualTask.id, {
            ok: false,
            summary: execResult.summary,
            commitSha: execResult.commitSha,
            verification: execResult.verification as Record<string, unknown>,
            error: execResult.failureReason,
          });
          manualPhases.push(phaseResult("RESOLVE_OR_FAIL", "failed", execResult.failureReason ?? "execution_failed"));

          const failedExecResult = {
            ok: false,
            executionStatus: "MANUAL_TASK_FAILED",
            selectedSource: "manual-action-queue",
            selectedTaskId: manualTask.id,
            selectedTaskTitle: manualTask.title,
            patchApplied: execResult.patchApplied,
            commitSha: execResult.commitSha ?? null,
            manualTaskStatus: "FAILED",
            safeExecutionGate: manualGateResult,
            manualQueueCounts: manualCounts,
            staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
            executionPhases: manualPhases,
            verification: execResult.verification ?? { buildOk: false, smokeOk: false, details: {} },
            resolution: { resolved: false, reason: execResult.failureReason ?? "execution_failed" },
            adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          };
          await storeLatestExecution(failedExecResult);
          return NextResponse.json(failedExecResult);
        }
      }
    } else if (hasActiveManualTask) {
      // Manual task exists (maybe BLOCKED or non-executionReady) — report status, don't drift to backlog
      // This only triggers if the active task isn't execution-ready but still requires attention
      const manualBlockResult = {
        ok: true,
        executionStatus: "MANUAL_QUEUE_ACTIVE_NOT_READY",
        selectedSource: "manual-action-queue",
        selectedTaskId: activeManualTask!.id,
        selectedTaskTitle: activeManualTask!.title,
        patchApplied: false,
        manualTaskStatus: activeManualTask!.status,
        manualQueueCounts: manualCounts,
        idleReason: manualCounts.idleReason ?? `manual_task_${activeManualTask!.id}_active_but_not_selectable`,
        staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
        blockedRecovery: blockedRecovery ? {
          attempted: blockedRecovery.attempted,
          recoveredCount: blockedRecovery.recoveredCount,
          enrichedCount: blockedRecovery.enrichedCount,
          recoveredTaskIds: blockedRecovery.recoveredTaskIds,
          fallbackHintsApplied: blockedRecovery.enrichedCount > 0,
        } : null,
        proactiveDiagnostics,
        executionPhases: [
          phaseResult("SELECT_TASK", "passed", "manual_queue_active_not_ready"),
        ],
        verification: { buildOk: true, smokeOk: true, details: {} },
        resolution: { resolved: false, reason: "manual_task_active_but_not_execution_ready" },
        message: `Manual task ${activeManualTask!.id} (${activeManualTask!.status}) is active — won't drift to engineering backlog`,
        adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
      };
      if (!dryRun) await storeLatestExecution(manualBlockResult);
      return NextResponse.json(manualBlockResult);
    }

    // ─── Learning Analysis + Safe Remediation ────────────────────────
    // After critical incidents are clear, run learning analysis to detect
    // trade performance and signal health issues. Apply at most one
    // safe remediation per run. Check pending verification windows.
    let learningResult = null;
    let remediationResult = null;
    let verificationResult = null;
    let ledgerSummary = null;
    try {
      learningResult = await runLearningAnalysis();

      if (learningResult.findings.length > 0) {
        if (!dryRun) {
          // Record high-severity findings in ledger
          for (const finding of learningResult.findings.filter(
            (f) => f.severity === "CRITICAL" || f.severity === "HIGH",
          )) {
            await recordLedgerEntry({
              type: "finding_detected",
              findingId: finding.id,
              findingCategory: finding.category,
              findingSeverity: finding.severity,
              reason: finding.evidence,
            }).catch(() => {});
          }

          // Apply at most one safe remediation
          remediationResult = await applyOneRemediation(learningResult.findings);
        }
      }

      // Check pending remediation verifications
      verificationResult = await checkPendingRemediations(learningResult.findings);

      // Get ledger summary for response
      ledgerSummary = await getLedgerSummary();
    } catch (err) {
      console.warn("[AGENT-EXECUTE] Learning analysis failed (non-fatal):", err);
    }

    // ─── SELECT_TASK phase ────────────────────────────────────────────
    const selectStart = Date.now();
    const tasks = await listEngineeringTasks(100);
    task = tasks
      .filter((candidate) => isEligibleTask(candidate))
      .sort((a, b) => executionSortRank(a) - executionSortRank(b))[0] ?? null;

    if (!task) {
      phases.push(phaseResult("SELECT_TASK", "passed", "no_eligible_tasks", selectStart));

      // ─── Compute idleReason: why is nothing selectable? ─────────────
      // Reload manual queue counts for the idle explanation (recovery already ran above)
      const idleManualCounts = await countOpenExecutionReadyManualTasks().catch(() => ({
        openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0,
        selectedCount: 0, selectableCount: 0, recoverableBlockedCount: 0, idleReason: null as string | null,
      }));
      const latestExecRaw2 = redis ? await redis.get<string>(AGENT_LATEST_EXECUTION_KEY).catch(() => null) : null;
      const previousExec = (() => {
        if (!latestExecRaw2) return null;
        try {
          const parsed = typeof latestExecRaw2 === "string" ? JSON.parse(latestExecRaw2) : latestExecRaw2;
          return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
        } catch { return null; }
      })();
      const previousStatus = previousExec?.executionStatus as string | undefined;

      let idleReason = idleManualCounts.idleReason ?? "no_engineering_or_manual_tasks_available";
      if (previousStatus === "MANUAL_TASK_FAILED") {
        idleReason = `previous_task_failed (${previousExec?.selectedTaskTitle ?? "unknown"}) — no remaining selectable work. ${idleReason}`;
      }

      const noTaskResult: ExecutionStateMachineResult = {
        executionStatus: "NO_TASK",
        selectedSource: "none",
        selectedTaskId: null,
        selectedTaskTitle: null,
        executionPhases: phases,
        patchApplied: false,
        verification: { buildOk: true, smokeOk: true, details: {} },
        resolution: { resolved: false, reason: "no_eligible_tasks" },
      };
      const result = {
        ok: true,
        message: "No execution-ready tasks",
        idleReason,
        ...noTaskResult,
        manualQueueCounts: idleManualCounts,
        proactiveDiagnostics,
        blockedRecovery: blockedRecovery ? {
          attempted: blockedRecovery.attempted,
          recoveredCount: blockedRecovery.recoveredCount,
          enrichedCount: blockedRecovery.enrichedCount,
          recoveredTaskIds: blockedRecovery.recoveredTaskIds,
          fallbackHintsApplied: blockedRecovery.enrichedCount > 0,
        } : null,
        adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
        ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
      };
      if (!dryRun) await storeLatestExecution(result);
      return NextResponse.json(result);
    }

    phases.push(phaseResult("SELECT_TASK", "passed", `task: ${task.id}`, selectStart));
    console.log(`[AGENT-EXECUTE] Selected task ${task.id}: ${task.title}`);

    // ─── DRY RUN: preview engineering backlog, ZERO mutations ────────
    if (dryRun) {
      const dryRunPatchPlan = generatePatchPlan(task);
      return NextResponse.json({
        ok: true,
        dryRun: true,
        executionStatus: "DRY_RUN",
        selectedSource: "engineering-backlog",
        selectedTaskId: task.id,
        selectedTaskTitle: task.title,
        taskStatus: task.status,
        patchApplied: false,
        commitSha: null,
        patchPlan: dryRunPatchPlan,
        githubWriteCapability: checkGitHubWriteCapability(),
        executionPhases: [
          ...phases,
          phaseResult("GENERATE_PATCH_PLAN", "skipped", "dry_run"),
          phaseResult("APPLY_PATCH", "skipped", "dry_run"),
          phaseResult("COMMIT_PUSH", "skipped", "dry_run"),
          phaseResult("VERIFY", "skipped", "dry_run"),
          phaseResult("RESOLVE_OR_FAIL", "skipped", "dry_run"),
        ],
        verification: { buildOk: true, smokeOk: true, details: {} },
        resolution: { resolved: false, reason: "dry_run" },
        adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
        ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
      });
    }

    // ─── GitHub write capability check ──────────────────────────────
    const ghCapability = checkGitHubWriteCapability();

    // ─── GENERATE_PATCH_PLAN phase ──────────────────────────────────
    const patchPlanStart = Date.now();
    let patchPlan: PatchPlanDetail | null = null;

    if (task.status === "READY_FOR_EXECUTION") {
      const guardrailError = validateExecutionGuardrails(task);

      if (guardrailError) {
        phases.push(phaseResult("GENERATE_PATCH_PLAN", "failed", guardrailError, patchPlanStart));
        const skippedNotes = appendNotes(task.notes, [`Execution skipped: ${guardrailError}`]);
        await updateEngineeringTaskById(task.id, {
          notes: skippedNotes,
          executionError: guardrailError,
        });

        const result = {
          ok: true,
          taskId: task.id,
          selectedSource: "engineering-backlog",
          selectedTaskId: task.id,
          selectedTaskTitle: task.title,
          executionStatus: task.executionStatus ?? "READY",
          skipped: true,
          reason: guardrailError,
          executionPhases: phases,
          patchApplied: false,
          githubWriteCapability: ghCapability,
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: guardrailError },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
        };
        await storeLatestExecution(result);
        return NextResponse.json(result);
      }

      patchPlan = generatePatchPlan(task);
      phases.push(phaseResult("GENERATE_PATCH_PLAN", "passed", `files: ${patchPlan.filesToModify.join(", ")}`, patchPlanStart));

      if (!ghCapability.writeEnabled) {
        phases.push(phaseResult("APPLY_PATCH", "failed", `github_write_disabled: ${ghCapability.reason}`));
        const result = {
          ok: false,
          taskId: task.id,
          selectedSource: "engineering-backlog",
          selectedTaskId: task.id,
          selectedTaskTitle: task.title,
          executionStatus: "FAILED",
          reason: `GitHub write not available: ${ghCapability.reason}`,
          patchPlan,
          executionPhases: phases,
          patchApplied: false,
          githubWriteCapability: ghCapability,
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: "github_write_disabled" },
          failure: { phase: "APPLY_PATCH", reason: ghCapability.reason ?? "github_write_disabled" },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
        };
        await storeLatestExecution(result);
        return NextResponse.json(result, { status: 500 });
      }

      try {
        const execResult = await executeReadyForGithubCommit(task, phases, dryRun);
        const responseBody = await execResult.response.json();
        const fullResult = {
          ...responseBody,
          githubWriteCapability: ghCapability,
          patchPlan,
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
          dryRun,
        };
        if (!dryRun) await storeLatestExecution(fullResult);
        return NextResponse.json(fullResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        phases.push(phaseResult("APPLY_PATCH", "failed", message));
        if (!dryRun) await blockExecution(task, message);

        const result = {
          ok: false,
          error: message,
          taskId: task.id,
          selectedSource: "engineering-backlog",
          selectedTaskId: task.id,
          selectedTaskTitle: task.title,
          executionStatus: dryRun ? "DRY_RUN" : "FAILED",
          executionPhases: phases,
          patchApplied: false,
          githubWriteCapability: ghCapability,
          verification: { buildOk: false, smokeOk: false, details: {} },
          resolution: { resolved: false, reason: message },
          failure: { phase: "APPLY_PATCH", reason: message },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
          dryRun,
        };
        if (!dryRun) await storeLatestExecution(result);
        return NextResponse.json(result, { status: 500 });
      }
    }

    // ─── OPEN task — needs governance approval + plan preparation ────
    const approval = task.status === "OPEN" ? approveExecution(task) : { ok: true as const };

    if (!approval.ok) {
      phases.push(phaseResult("GENERATE_PATCH_PLAN", "failed", `governance_blocked: ${approval.reason}`, patchPlanStart));
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

      const result = {
        ok: false,
        reason: approval.reason,
        taskId: task.id,
        selectedSource: "engineering-backlog",
        selectedTaskId: task.id,
        selectedTaskTitle: task.title,
        executionStatus: "BLOCKED",
        executionPhases: phases,
        patchApplied: false,
        githubWriteCapability: ghCapability,
        verification: { buildOk: true, smokeOk: true, details: {} },
        resolution: { resolved: false, reason: approval.reason },
        failure: { phase: "GENERATE_PATCH_PLAN", reason: approval.reason },
        adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
        ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
      };
      await storeLatestExecution(result);
      return NextResponse.json(result, { status: 403 });
    }

    const prepared = prepareExecutionPlan(task);
    patchPlan = generatePatchPlan(task);
    phases.push(phaseResult("GENERATE_PATCH_PLAN", "passed", `plan: ${prepared.nextTaskStatus}`, patchPlanStart));

    const approvedNotes = appendNotes(task.notes, [
      "Execution approved by governance manager",
      `Execution plan prepared for ${prepared.nextTaskStatus}`,
    ]);

    const preparedTask = buildReadyExecutionTask(task, {
      status: prepared.nextTaskStatus,
      patchPlan: prepared.patchPlan,
      validationPlan: prepared.validationPlan,
      commitPlan: prepared.commitPlan,
      executionStatus: prepared.executionStatus,
      executionError: null,
      notes: approvedNotes,
    });

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

    if (preparedTask.status === "READY_FOR_EXECUTION") {
      const guardrailError = validateExecutionGuardrails(preparedTask);

      if (guardrailError) {
        phases.push(phaseResult("APPLY_PATCH", "failed", guardrailError));
        await updateEngineeringTaskById(task.id, {
          notes: appendNotes(preparedTask.notes, [`Execution skipped: ${guardrailError}`]),
          executionError: guardrailError,
        });

        const result = {
          ok: true,
          taskId: task.id,
          selectedSource: "engineering-backlog",
          selectedTaskId: task.id,
          selectedTaskTitle: task.title,
          executionStatus: preparedTask.executionStatus ?? "READY",
          skipped: true,
          reason: guardrailError,
          patchPlan,
          executionPhases: phases,
          patchApplied: false,
          githubWriteCapability: ghCapability,
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: guardrailError },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
        };
        await storeLatestExecution(result);
        return NextResponse.json(result);
      }

      if (!ghCapability.writeEnabled) {
        phases.push(phaseResult("APPLY_PATCH", "failed", `github_write_disabled: ${ghCapability.reason}`));
        const result = {
          ok: false,
          taskId: task.id,
          selectedSource: "engineering-backlog",
          selectedTaskId: task.id,
          selectedTaskTitle: task.title,
          executionStatus: "FAILED",
          reason: `GitHub write not available: ${ghCapability.reason}`,
          patchPlan,
          executionPhases: phases,
          patchApplied: false,
          githubWriteCapability: ghCapability,
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: "github_write_disabled" },
          failure: { phase: "APPLY_PATCH", reason: ghCapability.reason ?? "github_write_disabled" },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
        };
        await storeLatestExecution(result);
        return NextResponse.json(result, { status: 500 });
      }

      try {
        const execResult = await executeReadyForGithubCommit(preparedTask, phases, dryRun);
        const responseBody = await execResult.response.json();
        const fullResult = {
          ...responseBody,
          githubWriteCapability: ghCapability,
          patchPlan,
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
          dryRun,
        };
        if (!dryRun) await storeLatestExecution(fullResult);
        return NextResponse.json(fullResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        phases.push(phaseResult("APPLY_PATCH", "failed", message));
        if (!dryRun) await blockExecution(preparedTask, message);
        const result = {
          ok: false,
          error: message,
          taskId: task.id,
          selectedSource: "engineering-backlog",
          selectedTaskId: task.id,
          selectedTaskTitle: task.title,
          executionStatus: dryRun ? "DRY_RUN" : "FAILED",
          executionPhases: phases,
          patchApplied: false,
          githubWriteCapability: ghCapability,
          verification: { buildOk: false, smokeOk: false, details: {} },
          resolution: { resolved: false, reason: message },
          failure: { phase: "APPLY_PATCH", reason: message },
          adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
          ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
          dryRun,
        };
        if (!dryRun) await storeLatestExecution(result);
        return NextResponse.json(result, { status: 500 });
      }
    }

    // Task prepared but not yet READY_FOR_EXECUTION — return plan
    phases.push(phaseResult("APPLY_PATCH", "skipped", "task_not_ready_for_execution"));
    const planResult = {
      ok: true,
      taskId: task.id,
      selectedSource: "engineering-backlog",
      selectedTaskId: task.id,
      selectedTaskTitle: task.title,
      executionStatus: prepared.nextTaskStatus,
      patchPlan,
      validationPlan: prepared.validationPlan,
      commitPlan: prepared.commitPlan,
      executionPhases: phases,
      patchApplied: false,
      githubWriteCapability: ghCapability,
      verification: { buildOk: true, smokeOk: true, details: {} },
      resolution: { resolved: false, reason: "plan_prepared_not_executed" },
      adaptiveGuardrails: adaptiveResult ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length } : null,
      ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
    };
    if (!dryRun) await storeLatestExecution(planResult);
    return NextResponse.json(planResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!dryRun) await markExecutionFailure(task, message);
    phases.push(phaseResult("RESOLVE_OR_FAIL", "failed", message));

    const result = {
      ok: false,
      error: message,
      dryRun,
      selectedSource: task ? "engineering-backlog" : "none",
      selectedTaskId: task?.id ?? null,
      selectedTaskTitle: task?.title ?? null,
      executionStatus: dryRun ? "DRY_RUN" : "FAILED",
      executionPhases: phases,
      patchApplied: false,
      commitSha: null,
      verification: { buildOk: false, smokeOk: false, details: {} },
      resolution: { resolved: false, reason: message },
      failure: { phase: "RESOLVE_OR_FAIL", reason: message },
    };
    if (!dryRun) await storeLatestExecution(result);
    return NextResponse.json(result, { status: 500 });
  }
}