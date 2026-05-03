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
import { runProfitEngine } from "@/lib/agents/profitEngine";
import type { ProfitEngineResult } from "@/lib/agents/profitEngine";
import { AGENT_LATEST_EXECUTION_KEY, AGENT_LATEST_BATCH_EXECUTION_KEY } from "@/lib/agents/keys";
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
  listManualActionTasks,
  computeTaskSelectability,
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
  // Allow GITHUB_COMMIT (explicit) and auto-generated plans (will be GITHUB_COMMIT after engine upgrade)
  if (task.patchPlan?.mode !== "GITHUB_COMMIT" && task.patchPlan?.mode !== undefined) {
    // Only block FILE_WRITE — PLACEHOLDER is treated as auto-generatable
    if (task.patchPlan.mode === "FILE_WRITE") {
      return "patch_mode_not_github_commit";
    }
    // PLACEHOLDER: engine will upgrade to GITHUB_COMMIT on prepareExecutionPlan — allow through
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

async function storeLatestBatchExecution(result: Record<string, unknown>): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(AGENT_LATEST_BATCH_EXECUTION_KEY, JSON.stringify(result), { ex: 86400 * 7 });
  } catch {
    // non-fatal
  }
}

// ─── Batch Execution Types ───────────────────────────────────────────

export type BatchExecStatus =
  | "BATCH_COMPLETED"
  | "BATCH_PARTIAL"
  | "NO_ELIGIBLE_TASKS"
  | "FAILED";

export interface BatchTaskResult {
  taskId: string | null;
  title: string | null;
  status: "COMPLETED" | "FAILED" | "BLOCKED" | "SKIPPED" | "NO_TASK";
  source: "manual-action-queue" | "engineering-backlog" | "none";
  patchApplied: boolean;
  commitSha?: string | null;
  verification: { buildOk: boolean; smokeOk: boolean; details: Record<string, unknown> };
  resolution: { resolved: boolean; reason?: string };
  executionPhases: ExecutionPhaseResult[];
  safetyStopReason?: string;
  noTaskReason?: string;
}

// ─── Priority-ordered engineering task selection ─────────────────────

const TRADING_FILE_PREFIXES = [
  "app/api/auto-entry",
  "app/api/scan",
  "app/api/ai",
  "app/api/trades",
  "lib/trading",
  "lib/alpaca",
  "lib/autoEntry",
];

const PRIORITY_BUCKET_RANK: Record<"CRITICAL" | "HIGH" | "MEDIUM" | "LOW", number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const BATCH_KEYWORD_BOOST_PATTERNS = [
  /underutilized.?funnel/i,
  /execution.?blocker/i,
  /malformed/i,
  /protection/i,
  /stale.?signal/i,
  /scoring/i,
  /tier_?c_?high_?loss/i,
  /aiScore/i,
  /price.?drift/i,
  /broker.?mismatch/i,
];

function touchesTradingFiles(paths: string[] | undefined | null): boolean {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.some((p) => {
    const normalized = String(p || "").trim().replace(/^\/+/, "").toLowerCase();
    return TRADING_FILE_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
  });
}

function engineeringPriorityBucket(task: EngineeringTask): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  if (task.incidentId) return "CRITICAL";
  if (titleKeywordBoost(task.title) < 0) return "HIGH";
  if (task.status === "READY_FOR_EXECUTION") return "HIGH";
  if (task.status === "OPEN") return "MEDIUM";
  return "LOW";
}

function titleKeywordBoost(title: string): number {
  for (const p of BATCH_KEYWORD_BOOST_PATTERNS) {
    if (p.test(title)) return -5; // negative = higher ranked
  }
  return 0;
}

function batchEngineeringTaskRank(task: EngineeringTask): number {
  const priorityRank = PRIORITY_BUCKET_RANK[engineeringPriorityBucket(task)] * 100;
  const statusRank = task.status === "READY_FOR_EXECUTION" ? 0 : task.status === "OPEN" ? 20 : 100;
  const kw = titleKeywordBoost(task.title);
  const age = Date.parse(task.createdAt) || 0; // older = lower number = better
  return priorityRank + statusRank + kw + age / 1e12; // age contribution tiny vs status
}

/**
 * Select the next engineering task from the list, excluding already-executed IDs.
 * Applies priority ordering: status rank, keyword boost, then createdAt (oldest first).
 */
function selectNextEngineeringTaskForBatch(
  tasks: EngineeringTask[],
  excludeIds: string[],
  priorityOnly: boolean,
): EngineeringTask | null {
  const excludeSet = new Set(excludeIds);
  let candidates = tasks
    .filter((t) => isEligibleTask(t) && !excludeSet.has(t.id));
  if (priorityOnly) {
    // Keep only tasks with CRITICAL/HIGH signals — use incidentId or keyword boost as proxy
    candidates = candidates.filter(
      (t) => t.incidentId != null || titleKeywordBoost(t.title) < 0,
    );
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => batchEngineeringTaskRank(a) - batchEngineeringTaskRank(b));
  return candidates[0];
}

// ─── Queue snapshot for before/after –──────────────────────────────

interface QueueSnapshot {
  openCount: number;
  executionReadyCount: number;
  selectableCount: number;
  inProgressCount: number;
  blockedCount: number;
  idleReason: string | null;
}

async function buildQueueSnapshot(): Promise<QueueSnapshot> {
  try {
    const counts = await countOpenExecutionReadyManualTasks();
    return {
      openCount: counts.openCount,
      executionReadyCount: counts.executionReadyCount,
      selectableCount: counts.selectableCount,
      inProgressCount: counts.inProgressCount,
      blockedCount: counts.blockedCount,
      idleReason: counts.idleReason,
    };
  } catch {
    return { openCount: 0, executionReadyCount: 0, selectableCount: 0, inProgressCount: 0, blockedCount: 0, idleReason: null };
  }
}

function computeBatchExecStatus(
  results: BatchTaskResult[],
  stoppedReason: string | null,
  requestedMax: number,
): BatchExecStatus {
  const completed = results.filter((r) => r.status === "COMPLETED").length;
  const failed = results.filter((r) => r.status === "FAILED" || r.status === "BLOCKED").length;
  const noTask = results.every((r) => r.status === "NO_TASK");
  if (noTask || results.length === 0) return "NO_ELIGIBLE_TASKS";
  if (completed === 0 && failed > 0) return "FAILED";
  if (completed === requestedMax) return "BATCH_COMPLETED";
  return "BATCH_PARTIAL";
}

// ─── Readiness diagnostics for tasks ─────────────────────────────────

interface TaskReadinessDiagnostic {
  executionReady: boolean;
  blockedReason: string | null;
  readinessReasons: string[];
  requiresApproval: boolean;
  hasPatchPlan: boolean;
  hasVerificationPlan: boolean;
}

function computeEngineeringTaskReadiness(task: EngineeringTask): TaskReadinessDiagnostic {
  const reasons: string[] = [];
  let executionReady = false;
  let blockedReason: string | null = null;
  let requiresApproval = false;
  const allowTradingFiles = process.env.AGENT_ALLOW_TRADING_FILES === "1";
  const tradingFilesTouched = touchesTradingFiles([
    ...(task.likelyFiles ?? []),
    ...(task.patchPlan?.targetFiles ?? []),
  ]);

  // hasPatchPlan: true when an explicit GITHUB_COMMIT plan exists,
  // OR when the engine can auto-generate one (non-trading-file tasks from eligible sources).
  const hasExplicitPatchPlan =
    task.patchPlan?.mode === "GITHUB_COMMIT" &&
    task.commitPlan?.pushDirect === true &&
    !!task.commitPlan?.commitMessage?.trim();
  const canAutoGeneratePatchPlan = !tradingFilesTouched || allowTradingFiles;
  const hasPatchPlan = hasExplicitPatchPlan || canAutoGeneratePatchPlan;
  const hasVerificationPlan = !!(task.validationPlan?.smokeChecks?.length || task.smokeTestBlock);

  if (task.status === "READY_FOR_EXECUTION") {
    if (tradingFilesTouched && !allowTradingFiles) {
      blockedReason = "trading_file_requires_approval";
      requiresApproval = true;
      reasons.push("task touches trading-sensitive files and AGENT_ALLOW_TRADING_FILES is not enabled");
    } else {
    const guardrailError = validateExecutionGuardrails(task);
    if (guardrailError) {
      blockedReason = guardrailError;
      reasons.push(`guardrail_failed: ${guardrailError}`);
    } else if (!checkGitHubWriteCapability().writeEnabled) {
      blockedReason = "github_write_disabled";
      reasons.push("GitHub write capability not available");
    } else {
      executionReady = true;
      reasons.push("ready_for_execution with valid patch + commit plan");
    }
    }
  } else if (task.status === "OPEN") {
    const approval = approveExecution(task);
    if (tradingFilesTouched && !allowTradingFiles) {
      requiresApproval = true;
    } else {
      requiresApproval = !approval.ok;
    }
    if (tradingFilesTouched && !allowTradingFiles) {
      blockedReason = "trading_file_requires_approval";
      reasons.push("task touches trading-sensitive files and AGENT_ALLOW_TRADING_FILES is not enabled");
    } else if (!approval.ok) {
      blockedReason = `governance_blocked: ${approval.reason}`;
      reasons.push(`governance approval failed: ${approval.reason}`);
    } else if (!hasExplicitPatchPlan) {
      // Patch plan will be auto-generated by engine on execution — not blocked
      executionReady = true;
      blockedReason = null;
      reasons.push("patch_plan_missing_auto_generated: will be generated on execution via keyword inference");
    } else {
      executionReady = true;
      reasons.push("open task passes governance, has patch plan — will be prepared on selection");
    }
  } else {
    blockedReason = `status: ${task.status}`;
    reasons.push(`not eligible in status ${task.status}`);
  }

  return { executionReady, blockedReason, readinessReasons: reasons, requiresApproval, hasPatchPlan, hasVerificationPlan };
}

// ─── Dry-run multi-task candidate collection ─────────────────────────

interface DryRunCandidate {
  taskId: string;
  title: string;
  source: "manual-action-queue" | "engineering-backlog";
  priority: string;
  taskType?: string;
  riskLevel?: string;
  executionReady: boolean;
  blockedReason: string | null;
  readinessReasons: string[];
  requiresApproval: boolean;
  hasPatchPlan: boolean;
  hasVerificationPlan: boolean;
  createdAt: string;
}

async function collectDryRunCandidates(
  max: number,
  priorityOnly: boolean,
): Promise<DryRunCandidate[]> {
  const candidates: DryRunCandidate[] = [];

  // Manual queue candidates
  try {
    const manualTasks = await listManualActionTasks({ status: "OPEN", executionReady: true, limit: max });
    for (const t of manualTasks) {
      if (candidates.length >= max) break;
      if (priorityOnly && t.priority !== "CRITICAL" && t.priority !== "HIGH") continue;
      const sel = computeTaskSelectability(t);
      candidates.push({
        taskId: t.id,
        title: t.title,
        source: "manual-action-queue",
        priority: t.priority,
        taskType: t.taskType,
        executionReady: sel.selectable,
        blockedReason: sel.selectable ? null : sel.reason,
        readinessReasons: sel.selectable ? ["open_and_execution_ready"] : [sel.reason],
        requiresApproval: false,
        hasPatchPlan: !!(t.fileHints?.length),
        hasVerificationPlan: !!(t.acceptanceCriteria?.length),
        createdAt: t.createdAt,
      });
    }
  } catch {
    // non-fatal
  }

  // Engineering backlog candidates
  if (candidates.length < max) {
    try {
      const engTasks = await listEngineeringTasks(100);
      const remaining = max - candidates.length;
      const existingIds = candidates.map((c) => c.taskId);
      let eligible = engTasks
        .filter((t) => isEligibleTask(t) && !existingIds.includes(t.id));
      if (priorityOnly) {
        eligible = eligible.filter((t) => t.incidentId != null || titleKeywordBoost(t.title) < 0);
      }
      eligible.sort((a, b) => batchEngineeringTaskRank(a) - batchEngineeringTaskRank(b));
      for (const t of eligible.slice(0, remaining)) {
        const readiness = computeEngineeringTaskReadiness(t);
        candidates.push({
          taskId: t.id,
          title: t.title,
          source: "engineering-backlog",
          priority: t.incidentId ? "HIGH" : "MEDIUM",
          executionReady: readiness.executionReady,
          blockedReason: readiness.blockedReason,
          readinessReasons: readiness.readinessReasons,
          requiresApproval: readiness.requiresApproval,
          hasPatchPlan: readiness.hasPatchPlan,
          hasVerificationPlan: readiness.hasVerificationPlan,
          createdAt: t.createdAt,
        });
      }
    } catch {
      // non-fatal
    }
  }

  return candidates;
}

// ─── Single-task cycle (for batch loop) ──────────────────────────────

interface RunOneCycleOptions {
  adaptiveResult: { actionsApplied: { length: number }; activeActions: { length: number } } | null;
  excludedTaskIds: string[];
  priorityOnly: boolean;
}

/**
 * Execute one manual or engineering task. Returns a CycleResult without
 * returning a NextResponse — the caller accumulates results for the batch.
 */
async function runOneCycle(opts: RunOneCycleOptions): Promise<BatchTaskResult> {
  const { adaptiveResult: _adaptiveResult, excludedTaskIds, priorityOnly } = opts;

  // ── Step A: Manual queue (priority) ───────────────────────────────
  const manualCounts = await countOpenExecutionReadyManualTasks().catch(() => ({
    openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0,
    selectedCount: 0, selectableCount: 0, recoverableBlockedCount: 0, idleReason: null as string | null,
  }));
  const activeManualTask = await getActiveManualTask().catch(() => null);
  const hasManualWork = (manualCounts.selectableCount ?? manualCounts.executionReadyCount) > 0
    || manualCounts.inProgressCount > 0
    || manualCounts.selectedCount > 0;

  if (hasManualWork) {
    const manualPhases: ExecutionPhaseResult[] = [];
    const manualTask = await claimNextManualActionTask();
    if (!manualTask) {
      // Queue drained between count and claim — fall through to engineering
    } else {
      manualPhases.push(phaseResult("SELECT_TASK", "passed", "manual_queue"));
      manualPhases.push(phaseResult("CLAIM_TASK", "passed", `claimed: ${manualTask.id}`));

      const startedTask = await startManualActionTask(manualTask.id);
      if (!startedTask) {
        manualPhases.push(phaseResult("CLAIM_TASK", "failed", "start_failed"));
        return {
          taskId: manualTask.id, title: manualTask.title, status: "FAILED",
          source: "manual-action-queue", patchApplied: false,
          verification: { buildOk: false, smokeOk: false, details: { reason: "lifecycle_start_failed" } },
          resolution: { resolved: false, reason: "lifecycle_start_failed" },
          executionPhases: manualPhases,
        };
      }

      let manualGateResult: GateResult | null = null;
      try {
        manualGateResult = await runSafeExecutionGate({
          id: manualTask.id, incidentCode: "MANUAL_QUEUE",
          symbol: "SYSTEM", severity: manualTask.priority,
          detail: manualTask.title, createdAt: manualTask.createdAt,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        manualGateResult = {
          passed: false, buildOk: false,
          buildProbe: { route: "/api/agents/state", ok: false, status: null, reason: errMsg },
          smokeOk: false, smokeProbes: [], validatedAt: new Date().toISOString(),
          failureReason: `gate_exception: ${errMsg}`, baseUrl: "unknown", authMode: "unknown",
        };
      }

      if (manualGateResult && !manualGateResult.passed) {
        const blockedReason = manualGateResult.failureReason ?? "safe_execution_gate_failed";
        await blockManualActionTask(manualTask.id, blockedReason, {
          ok: false, summary: `Safe execution gate failed: ${blockedReason}`, error: blockedReason,
        });
        manualPhases.push(phaseResult("APPLY_PATCH", "failed", blockedReason));
        return {
          taskId: manualTask.id, title: manualTask.title, status: "BLOCKED",
          source: "manual-action-queue", patchApplied: false,
          verification: { buildOk: manualGateResult.buildOk, smokeOk: manualGateResult.smokeOk, details: {} },
          resolution: { resolved: false, reason: "gate_failed" },
          executionPhases: manualPhases,
          safetyStopReason: "safety_gate_blocked",
        };
      }

      manualPhases.push(phaseResult("APPLY_PATCH", "passed", "gate_passed_invoking_executor"));

      let execResult;
      try {
        execResult = await executeManualTask(manualTask);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        execResult = { ok: false, patchApplied: false, blocked: false, summary: `Executor threw: ${errMsg}`, failureReason: errMsg };
      }

      manualPhases.push(phaseResult(
        "APPLY_PATCH",
        execResult.patchApplied ? "passed" : "failed",
        execResult.patchApplied ? `patch_applied: ${execResult.commitSha ?? "no_sha"}`
          : execResult.blockedReason ?? execResult.failureReason ?? "executor_failed",
      ));
      manualPhases.push(phaseResult(
        "VERIFY",
        execResult.ok ? "passed" : execResult.blocked ? "skipped" : "failed",
        execResult.ok ? "verification_passed"
          : execResult.blocked ? (execResult.blockedReason ?? "blocked")
          : execResult.failureReason ?? "verification_failed",
      ));

      if (execResult.ok && execResult.patchApplied) {
        await completeManualActionTask(manualTask.id, {
          ok: true, summary: execResult.summary, commitSha: execResult.commitSha,
          verification: execResult.verification as Record<string, unknown>,
        });
        manualPhases.push(phaseResult("RESOLVE_OR_FAIL", "passed", "completed"));
        const verif = (execResult.verification ?? { buildOk: true, smokeOk: true, details: {} }) as { buildOk: boolean; smokeOk: boolean; details: Record<string, unknown> };
        if (!verif.buildOk || !verif.smokeOk) {
          return {
            taskId: manualTask.id, title: manualTask.title, status: "COMPLETED",
            source: "manual-action-queue", patchApplied: true, commitSha: execResult.commitSha ?? null,
            verification: verif, resolution: { resolved: true },
            executionPhases: manualPhases,
            safetyStopReason: "verification_failed",
          };
        }
        return {
          taskId: manualTask.id, title: manualTask.title, status: "COMPLETED",
          source: "manual-action-queue", patchApplied: true, commitSha: execResult.commitSha ?? null,
          verification: verif, resolution: { resolved: true },
          executionPhases: manualPhases,
        };
      } else if (execResult.blocked) {
        await blockManualActionTask(manualTask.id, execResult.blockedReason ?? "executor_blocked", {
          ok: false, summary: execResult.summary, error: execResult.blockedReason,
        });
        manualPhases.push(phaseResult("RESOLVE_OR_FAIL", "failed", execResult.blockedReason ?? "blocked"));
        return {
          taskId: manualTask.id, title: manualTask.title, status: "BLOCKED",
          source: "manual-action-queue", patchApplied: false,
          verification: (execResult.verification ?? { buildOk: false, smokeOk: false, details: {} }) as { buildOk: boolean; smokeOk: boolean; details: Record<string, unknown> },
          resolution: { resolved: false, reason: execResult.blockedReason ?? "executor_blocked" },
          executionPhases: manualPhases,
          safetyStopReason: "patch_executor_disabled",
        };
      } else {
        await failManualActionTask(manualTask.id, {
          ok: false, summary: execResult.summary, commitSha: execResult.commitSha,
          verification: execResult.verification as Record<string, unknown>, error: execResult.failureReason,
        });
        manualPhases.push(phaseResult("RESOLVE_OR_FAIL", "failed", execResult.failureReason ?? "execution_failed"));
        return {
          taskId: manualTask.id, title: manualTask.title, status: "FAILED",
          source: "manual-action-queue", patchApplied: execResult.patchApplied,
          commitSha: execResult.commitSha ?? null,
          verification: (execResult.verification ?? { buildOk: false, smokeOk: false, details: {} }) as { buildOk: boolean; smokeOk: boolean; details: Record<string, unknown> },
          resolution: { resolved: false, reason: execResult.failureReason ?? "execution_failed" },
          executionPhases: manualPhases,
        };
      }
    }
  } else if (activeManualTask) {
    // Active task not ready — stop batch to avoid drifting to engineering
    return {
      taskId: activeManualTask.id, title: activeManualTask.title, status: "SKIPPED",
      source: "manual-action-queue", patchApplied: false,
      verification: { buildOk: true, smokeOk: true, details: {} },
      resolution: { resolved: false, reason: "manual_task_active_but_not_execution_ready" },
      executionPhases: [phaseResult("SELECT_TASK", "passed", "manual_queue_active_not_ready")],
      safetyStopReason: "manual_task_active_not_ready",
    };
  }

  // ── Step B: Engineering backlog ───────────────────────────────────
  const allEngTasks = await listEngineeringTasks(100);
  const engTask = selectNextEngineeringTaskForBatch(allEngTasks, excludedTaskIds, priorityOnly);

  if (!engTask) {
    const noTaskReason = manualCounts.idleReason ?? "no_engineering_or_manual_tasks_available";
    return {
      taskId: null, title: null, status: "NO_TASK", source: "none", patchApplied: false,
      verification: { buildOk: true, smokeOk: true, details: {} },
      resolution: { resolved: false, reason: "no_eligible_tasks" },
      executionPhases: [phaseResult("SELECT_TASK", "passed", "no_eligible_tasks")],
      noTaskReason,
    };
  }

  const engPhases: ExecutionPhaseResult[] = [];
  engPhases.push(phaseResult("SELECT_TASK", "passed", `task: ${engTask.id}`));

  const allowTradingFiles = process.env.AGENT_ALLOW_TRADING_FILES === "1";
  const tradingFilesTouched = touchesTradingFiles([
    ...(engTask.likelyFiles ?? []),
    ...(engTask.patchPlan?.targetFiles ?? []),
  ]);
  if (tradingFilesTouched && !allowTradingFiles) {
    engPhases.push(phaseResult("GENERATE_PATCH_PLAN", "failed", "trading_file_requires_human_approval"));
    await updateEngineeringTaskById(engTask.id, {
      status: "BLOCKED",
      remediationAttempted: true,
      remediationStatus: "failed",
      remediationResultSummary: "Execution blocked: trading_file_requires_human_approval",
      executionStatus: "BLOCKED",
      executionError: "trading_file_requires_human_approval",
      notes: appendNotes(engTask.notes, ["Execution blocked: trading_file_requires_human_approval"]),
    });
    return {
      taskId: engTask.id,
      title: engTask.title,
      status: "BLOCKED",
      source: "engineering-backlog",
      patchApplied: false,
      verification: { buildOk: true, smokeOk: true, details: {} },
      resolution: { resolved: false, reason: "trading_file_requires_human_approval" },
      executionPhases: engPhases,
      safetyStopReason: "requires_approval",
    };
  }

  const ghCapability = checkGitHubWriteCapability();

  let taskToExecute: EngineeringTask = engTask;

  // Governance approval for OPEN tasks
  if (engTask.status === "OPEN") {
    const approval = approveExecution(engTask);
    if (!approval.ok) {
      engPhases.push(phaseResult("GENERATE_PATCH_PLAN", "failed", `governance_blocked: ${approval.reason}`));
      await updateEngineeringTaskById(engTask.id, {
        status: "BLOCKED", remediationAttempted: true, remediationStatus: "failed",
        remediationResultSummary: `Execution blocked: ${approval.reason}`,
        executionStatus: "BLOCKED", executionError: approval.reason,
        notes: appendNotes(engTask.notes, [`Execution blocked: ${approval.reason}`]),
      });
      return {
        taskId: engTask.id, title: engTask.title, status: "BLOCKED", source: "engineering-backlog",
        patchApplied: false, verification: { buildOk: true, smokeOk: true, details: {} },
        resolution: { resolved: false, reason: approval.reason },
        executionPhases: engPhases,
        safetyStopReason: "requires_approval",
      };
    }

    const prepared = prepareExecutionPlan(engTask);
    const patchPlan = generatePatchPlan(engTask);
    engPhases.push(phaseResult("GENERATE_PATCH_PLAN", "passed", `plan: ${prepared.nextTaskStatus} source: ${prepared.patchPlanSource ?? "explicit"}`));

    const approvedNotes = appendNotes(engTask.notes, [
      "Execution approved by governance manager",
      `Execution plan prepared for ${prepared.nextTaskStatus}`,
      prepared.patchPlanSource === "auto_generated"
        ? `Patch plan auto-generated (keyword inference): ${prepared.patchPlan.targetFiles.join(", ")}`
        : "",
    ]);

    taskToExecute = buildReadyExecutionTask(engTask, {
      status: prepared.nextTaskStatus,
      patchPlan: prepared.patchPlan,
      validationPlan: prepared.validationPlan,
      commitPlan: prepared.commitPlan,
      executionStatus: prepared.executionStatus,
      executionError: null,
      notes: approvedNotes,
    });

    await updateEngineeringTaskById(engTask.id, {
      status: prepared.nextTaskStatus, remediationAttempted: true, remediationStatus: "attempted",
      remediationResultSummary: "Execution plan prepared and queued for external executor.",
      patchPlan: prepared.patchPlan, validationPlan: prepared.validationPlan,
      commitPlan: prepared.commitPlan, executionStatus: prepared.executionStatus,
      executionError: null, notes: approvedNotes,
    });

    if (taskToExecute.status !== "READY_FOR_EXECUTION" && taskToExecute.status !== "READY_FOR_PUSH") {
      engPhases.push(phaseResult("APPLY_PATCH", "skipped", "task_not_ready_for_execution"));
      return {
        taskId: engTask.id, title: engTask.title, status: "SKIPPED", source: "engineering-backlog",
        patchApplied: false, verification: { buildOk: true, smokeOk: true, details: {} },
        resolution: { resolved: false, reason: "plan_prepared_not_executed" },
        executionPhases: engPhases,
        noTaskReason: patchPlan ? undefined : "plan_prepared",
      };
    }
  }

  // At this point taskToExecute should be READY_FOR_EXECUTION
  const guardrailError = validateExecutionGuardrails(taskToExecute);
  if (guardrailError) {
    engPhases.push(phaseResult("GENERATE_PATCH_PLAN", "failed", guardrailError));
    await updateEngineeringTaskById(taskToExecute.id, {
      notes: appendNotes(taskToExecute.notes, [`Execution skipped: ${guardrailError}`]),
      executionError: guardrailError,
    });
    return {
      taskId: taskToExecute.id, title: taskToExecute.title, status: "SKIPPED",
      source: "engineering-backlog", patchApplied: false,
      verification: { buildOk: true, smokeOk: true, details: {} },
      resolution: { resolved: false, reason: guardrailError },
      executionPhases: engPhases,
    };
  }

  if (!ghCapability.writeEnabled) {
    engPhases.push(phaseResult("APPLY_PATCH", "failed", `github_write_disabled: ${ghCapability.reason}`));
    return {
      taskId: taskToExecute.id, title: taskToExecute.title, status: "FAILED",
      source: "engineering-backlog", patchApplied: false,
      verification: { buildOk: true, smokeOk: true, details: {} },
      resolution: { resolved: false, reason: "github_write_disabled" },
      executionPhases: engPhases,
      safetyStopReason: "github_write_disabled",
    };
  }

  try {
    const execResult = await executeReadyForGithubCommit(taskToExecute, engPhases, false);
    const responseBody = await execResult.response.json() as Record<string, unknown>;
    const verif = (responseBody.verification ?? { buildOk: true, smokeOk: true, details: {} }) as { buildOk: boolean; smokeOk: boolean; details: Record<string, unknown> };
    const resolved = (responseBody.resolution as { resolved?: boolean } | undefined)?.resolved ?? false;
    const taskStatus = resolved ? "COMPLETED" as const : "FAILED" as const;
    const stopReason = (!verif.buildOk || !verif.smokeOk) ? "verification_failed" : undefined;
    return {
      taskId: taskToExecute.id, title: taskToExecute.title, status: taskStatus,
      source: "engineering-backlog", patchApplied: responseBody.patchApplied as boolean ?? false,
      commitSha: responseBody.commitSha as string | null ?? null,
      verification: verif, resolution: { resolved, reason: (responseBody.resolution as { reason?: string } | undefined)?.reason },
      executionPhases: engPhases,
      safetyStopReason: stopReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    engPhases.push(phaseResult("APPLY_PATCH", "failed", message));
    await blockExecution(taskToExecute, message);
    return {
      taskId: taskToExecute.id, title: taskToExecute.title, status: "FAILED",
      source: "engineering-backlog", patchApplied: false,
      verification: { buildOk: false, smokeOk: false, details: { error: message } },
      resolution: { resolved: false, reason: message },
      executionPhases: engPhases,
      safetyStopReason: "verification_failed",
    };
  }
}

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  // ─── Dry-run detection ──────────────────────────────────────────────
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dry_run") === "1";

  // ─── Batch execution params ─────────────────────────────────────────
  const requestedMax = Math.max(1, Math.min(5,
    Number(url.searchParams.get("max") ?? url.searchParams.get("limit") ?? "1") || 1,
  ));
  const envMaxTasks = Math.max(1, Math.min(5, Number(process.env.AGENT_MAX_TASKS_PER_RUN ?? "3") || 3));
  const effectiveRequestedMax = Math.min(requestedMax, envMaxTasks);
  const priorityOnly = url.searchParams.get("priorityOnly") === "1";
  const autonomyEnabled = process.env.AGENT_AUTONOMY_ENABLED === "1";
  const requireVerification = process.env.AGENT_REQUIRE_VERIFICATION !== "0";
  const TIME_BUDGET_MS = 90_000;
  const batchStartMs = Date.now();

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

    // ─── Profit Optimization Engine ──────────────────────────────────
    // Detect performance patterns, funnel issues, and generate optimization tasks.
    // Must run after adaptive guardrails (which may create tasks too).
    let profitEngineResult: ProfitEngineResult | null = null;
    if (!dryRun) {
      try {
        const baseUrl = resolveExecuteBaseUrl();
        const allEngTasksForDedup = await listEngineeringTasks(100).catch(() => []);
        profitEngineResult = await runProfitEngine(baseUrl, allEngTasksForDedup);
        if (profitEngineResult.ran) {
          console.log(
            `[AGENT-EXECUTE] Profit engine: patterns=${profitEngineResult.patternsDetected.length} ` +
            `tasks=${profitEngineResult.tasksCreated.length} ` +
            `funnelBlocked=${profitEngineResult.funnelBlocked} ` +
            `winRate=${profitEngineResult.winRate} avgR=${profitEngineResult.avgR}`,
          );
        }
      } catch (err) {
        console.warn("[AGENT-EXECUTE] Profit engine evaluation failed (non-fatal):", err);
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

    // ─── Manual + Engineering Batch Execution Loop (priority B+C) ─────

    // ─── Queue snapshot before ────────────────────────────────────────
    const queueBefore = await buildQueueSnapshot();

    // ─── Autonomy hard stop when disabled ─────────────────────────────
    if (!autonomyEnabled && !dryRun) {
      const candidates = await collectDryRunCandidates(effectiveRequestedMax, priorityOnly);
      const autonomyDisabledResponse = {
        ok: true,
        dryRun: false,
        executionStatus: "NO_ELIGIBLE_TASKS" as const,
        requestedMax,
        effectiveRequestedMax,
        executedCount: 0,
        completedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        stoppedReason: "autonomy_disabled",
        results: candidates.map((c) => ({
          taskId: c.taskId,
          title: c.title,
          status: "SKIPPED" as const,
          source: c.source,
          patchApplied: false,
          commitSha: null,
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: "autonomy_disabled" },
          executionPhases: [] as ExecutionPhaseResult[],
        })),
        queueBefore,
        queueAfter: queueBefore,
        autonomyEnabled,
        envSafety: {
          AGENT_AUTONOMY_ENABLED: process.env.AGENT_AUTONOMY_ENABLED ?? null,
          AGENT_MAX_TASKS_PER_RUN: envMaxTasks,
          AGENT_REQUIRE_VERIFICATION: process.env.AGENT_REQUIRE_VERIFICATION ?? "1",
          AGENT_ALLOW_TRADING_FILES: process.env.AGENT_ALLOW_TRADING_FILES ?? "0",
        },
        proactiveDiagnostics,
      };
      await storeLatestExecution(autonomyDisabledResponse as Record<string, unknown>);
      await storeLatestBatchExecution(autonomyDisabledResponse as Record<string, unknown>);
      return NextResponse.json(autonomyDisabledResponse);
    }

    if (!dryRun && proactiveEscalation.attempted && proactiveEscalation.auditOk === false) {
      const protectionBlocked = {
        ok: true,
        executionStatus: "NO_ELIGIBLE_TASKS" as const,
        requestedMax,
        effectiveRequestedMax,
        executedCount: 0,
        completedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        stoppedReason: "protection_audit_failed",
        results: [] as BatchTaskResult[],
        queueBefore,
        queueAfter: queueBefore,
        proactiveDiagnostics,
        autonomyEnabled,
      };
      await storeLatestExecution(protectionBlocked as Record<string, unknown>);
      await storeLatestBatchExecution(protectionBlocked as Record<string, unknown>);
      return NextResponse.json(protectionBlocked);
    }

    // ─── Dry run: collect top-N selectable candidates ─────────────────
    if (dryRun) {
      const candidates = await collectDryRunCandidates(effectiveRequestedMax, priorityOnly);
      const batchDryResult = {
        ok: true,
        dryRun: true,
        executionStatus: "DRY_RUN" as const,
        requestedMax,
        effectiveRequestedMax,
        executedCount: 0,
        completedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        stoppedReason: candidates.length === 0 ? "no_eligible_tasks" : "dry_run",
        noEligibleReason: candidates.length === 0 ? (queueBefore.idleReason ?? "no_open_tasks") : null,
        results: candidates.map((c) => ({
          taskId: c.taskId,
          title: c.title,
          status: "SKIPPED" as const,
          source: c.source,
          priority: c.priority,
          taskType: c.taskType ?? null,
          patchApplied: false,
          commitSha: null,
          verification: { buildOk: true, smokeOk: true, details: {} },
          resolution: { resolved: false, reason: "dry_run" },
          executionReady: c.executionReady,
          blockedReason: c.blockedReason,
          readinessReasons: c.readinessReasons,
          requiresApproval: c.requiresApproval,
          hasPatchPlan: c.hasPatchPlan,
          hasVerificationPlan: c.hasVerificationPlan,
          executionPhases: [],
        })),
        queueBefore,
        queueAfter: queueBefore,
        proactiveDiagnostics,
        adaptiveGuardrails: adaptiveResult
          ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length }
          : null,
      };
      return NextResponse.json(batchDryResult);
    }

    // ─── One-time recoveries before batch loop ────────────────────────
    let staleRecovery: StaleRecoveryResult;
    try {
      staleRecovery = await recoverStaleManualTasks(false);
      if (staleRecovery.recoveredCount > 0 || staleRecovery.recovered.length > 0) {
        console.log(`[AGENT-EXECUTE] Stale recovery: ${staleRecovery.recoveredCount} tasks recovered`);
      }
    } catch (err) {
      console.warn("[AGENT-EXECUTE] Stale recovery failed (non-fatal):", err);
      staleRecovery = { attempted: true, recoveredCount: 0, recovered: [], recoveredTaskIds: [], failedTaskIds: [], releasedTaskIds: [], reasonCodes: [] };
    }

    let failedTaskCleanup: FailedTaskCleanupResult | null = null;
    try {
      failedTaskCleanup = await cleanupFailedTasks(false);
      if (failedTaskCleanup && failedTaskCleanup.archivedCount > 0) {
        console.log(`[AGENT-EXECUTE] Archived ${failedTaskCleanup.archivedCount} old FAILED/BLOCKED tasks: [${failedTaskCleanup.archivedTaskIds}]`);
      }
    } catch (err) {
      console.warn("[AGENT-EXECUTE] Failed task cleanup failed (non-fatal):", err);
    }

    let blockedRecovery: BlockedTaskRecoveryResult | null = null;
    try {
      blockedRecovery = await recoverBlockedTasksWithFallbackHints(false);
      if (blockedRecovery.recoveredCount > 0) {
        console.log(`[AGENT-EXECUTE] Blocked task recovery: ${blockedRecovery.recoveredCount} tasks unblocked`);
      }
    } catch (err) {
      console.warn("[AGENT-EXECUTE] Blocked task recovery failed (non-fatal):", err);
      blockedRecovery = { attempted: true, recoveredCount: 0, enrichedCount: 0, candidates: [], recoveredTaskIds: [], enrichedTaskIds: [], skippedTaskIds: [] };
    }

    proactiveDiagnostics.staleRecoveryAttempted = staleRecovery.attempted;
    proactiveDiagnostics.staleRecoveryCount = staleRecovery.recoveredCount;
    (proactiveDiagnostics as Record<string, unknown>).blockedRecoveryAttempted = blockedRecovery?.attempted ?? false;
    (proactiveDiagnostics as Record<string, unknown>).blockedRecoveryCount = blockedRecovery?.recoveredCount ?? 0;
    (proactiveDiagnostics as Record<string, unknown>).blockedRecoveryEnrichedCount = blockedRecovery?.enrichedCount ?? 0;

    // ─── Learning Analysis (once, before loop) ───────────────────────
    let learningResult = null;
    let remediationResult = null;
    let verificationResult = null;
    let ledgerSummary = null;
    try {
      learningResult = await runLearningAnalysis();
      if (learningResult.findings.length > 0) {
        for (const finding of learningResult.findings.filter(
          (f) => f.severity === "CRITICAL" || f.severity === "HIGH",
        )) {
          await recordLedgerEntry({
            type: "finding_detected", findingId: finding.id,
            findingCategory: finding.category, findingSeverity: finding.severity,
            reason: finding.evidence,
          }).catch(() => {});
        }
        remediationResult = await applyOneRemediation(learningResult.findings);
      }
      verificationResult = await checkPendingRemediations(learningResult.findings);
      ledgerSummary = await getLedgerSummary();
    } catch (err) {
      console.warn("[AGENT-EXECUTE] Learning analysis failed (non-fatal):", err);
    }

    // ─── Batch Execution Loop ─────────────────────────────────────────
    const batchResults: BatchTaskResult[] = [];
    const executedTaskIds: string[] = [];
    let stoppedReason: string | null = null;
    let executedCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    // Failure rate guard — stop batch if > 50% tasks fail after at least 2 attempts
    const FAILURE_RATE_THRESHOLD = 0.5;
    const FAILURE_RATE_MIN_ATTEMPTS = 2;

    console.log(`[AGENT-EXECUTE] Batch loop: requestedMax=${requestedMax} effectiveMax=${effectiveRequestedMax} priorityOnly=${priorityOnly}`);

    for (let i = 0; i < effectiveRequestedMax; i++) {
      if (Date.now() - batchStartMs > TIME_BUDGET_MS) {
        stoppedReason = "time_budget_exceeded";
        console.warn("[AGENT-EXECUTE] Batch loop: time budget exceeded after ${i} iterations");
        break;
      }

      const cycle = await runOneCycle({ adaptiveResult, excludedTaskIds: executedTaskIds, priorityOnly });

      if (cycle.status === "NO_TASK") {
        stoppedReason = cycle.noTaskReason ?? "no_open_tasks";
        break;
      }

      if (cycle.status === "SKIPPED" && cycle.safetyStopReason === "manual_task_active_not_ready") {
        stoppedReason = "manual_task_active_not_ready";
        batchResults.push(cycle);
        break;
      }

      batchResults.push(cycle);
      if (cycle.taskId) executedTaskIds.push(cycle.taskId);

      if (cycle.status === "COMPLETED") {
        completedCount++;
        executedCount++;
      } else if (cycle.status === "FAILED" || cycle.status === "BLOCKED") {
        failedCount++;
        executedCount++;
      } else if (cycle.status === "SKIPPED") {
        skippedCount++;
      }

      if (cycle.safetyStopReason) {
        if (!requireVerification && cycle.safetyStopReason === "verification_failed") {
          console.warn("[AGENT-EXECUTE] Verification failed but AGENT_REQUIRE_VERIFICATION=0, continuing batch loop");
          continue;
        }
        stoppedReason = cycle.safetyStopReason;
        console.warn(`[AGENT-EXECUTE] Batch loop safety stop at iteration ${i + 1}: ${stoppedReason}`);
        break;
      }

      // Failure rate guard: stop if > 50% fail after minimum attempts
      if (executedCount >= FAILURE_RATE_MIN_ATTEMPTS) {
        const failureRate = failedCount / executedCount;
        if (failureRate > FAILURE_RATE_THRESHOLD) {
          stoppedReason = "failure_rate_exceeded";
          console.warn(`[AGENT-EXECUTE] Batch loop stopped: failure rate ${failureRate.toFixed(2)} > threshold after ${executedCount} tasks`);
          break;
        }
      }

      console.log(`[AGENT-EXECUTE] Batch iteration ${i + 1}/${effectiveRequestedMax}: task=${cycle.taskId} status=${cycle.status}`);
    }

    const queueAfter = await buildQueueSnapshot();
    const batchExecStatus = computeBatchExecStatus(batchResults, stoppedReason, effectiveRequestedMax);
    const firstResult = batchResults[0] ?? null;

    // Normalize stoppedReason to documented external values
    const normalizeStoppedReason = (r: string | null): string | null => {
      if (!r) return null;
      if (r === "safety_gate_blocked" || r === "safe_execution_gate_failed") return "safety_gate_failed";
      if (r === "requires_approval" || r === "trading_file_requires_approval") return "approval_required";
      if (r === "trading_file_requires_human_approval") return "trading_file_blocked";
      if (r === "patch_executor_disabled") return "approval_required";
      if (r === "no_open_tasks" || r === "no_eligible_tasks") return "no_more_selectable_tasks";
      return r;
    };
    const normalizedStoppedReason = normalizeStoppedReason(stoppedReason);

    // Derive human-readable no-task reason
    let noEligibleReason: string | null = null;
    if (batchExecStatus === "NO_ELIGIBLE_TASKS") {
      if (stoppedReason === "time_budget_exceeded") {
        noEligibleReason = "time_budget_exceeded";
      } else if (queueBefore.blockedCount > 0 && queueBefore.selectableCount === 0) {
        noEligibleReason = "trading_file_requires_approval";
      } else if (!checkGitHubWriteCapability().writeEnabled) {
        noEligibleReason = "github_write_disabled";
      } else {
        noEligibleReason = queueBefore.idleReason ?? "no_open_tasks";
      }
    }

    const execTimestamp = new Date().toISOString();
    const batchResponse = {
      ok: batchExecStatus !== "FAILED",
      executionStatus: batchExecStatus,
      timestamp: execTimestamp,
      executedAt: execTimestamp,
      requestedMax,
      effectiveRequestedMax,
      executedCount,
      completedCount,
      failedCount,
      skippedCount,
      stoppedReason: normalizedStoppedReason,
      noEligibleReason,
      results: batchResults,
      queueBefore,
      queueAfter,
      autonomyEnabled,
      envSafety: {
        AGENT_AUTONOMY_ENABLED: process.env.AGENT_AUTONOMY_ENABLED ?? null,
        AGENT_MAX_TASKS_PER_RUN: envMaxTasks,
        AGENT_REQUIRE_VERIFICATION: process.env.AGENT_REQUIRE_VERIFICATION ?? "1",
        AGENT_ALLOW_TRADING_FILES: process.env.AGENT_ALLOW_TRADING_FILES ?? "0",
      },
      // ─── Legacy single-task compat ───────────────────────────────────
      selectedSource: firstResult?.source ?? "none",
      selectedTaskId: firstResult?.taskId ?? null,
      selectedTaskTitle: firstResult?.title ?? null,
      patchApplied: firstResult?.patchApplied ?? false,
      commitSha: firstResult?.commitSha ?? null,
      executionPhases: firstResult?.executionPhases ?? [],
      verification: firstResult?.verification ?? { buildOk: true, smokeOk: true, details: {} },
      resolution: firstResult?.resolution ?? { resolved: false, reason: noEligibleReason ?? "no_task" },
      // ─── Diagnostics ─────────────────────────────────────────────────
      proactiveDiagnostics,
      staleRecovery: staleRecovery.attempted ? staleRecovery : undefined,
      blockedRecovery: blockedRecovery
        ? {
            attempted: blockedRecovery.attempted,
            recoveredCount: blockedRecovery.recoveredCount,
            enrichedCount: blockedRecovery.enrichedCount,
            fallbackHintsApplied: blockedRecovery.enrichedCount > 0,
          }
        : null,
      failedTaskCleanup: failedTaskCleanup
        ? { archivedCount: failedTaskCleanup.archivedCount, archivedTaskIds: failedTaskCleanup.archivedTaskIds }
        : null,
      adaptiveGuardrails: adaptiveResult
        ? { actionsApplied: adaptiveResult.actionsApplied.length, activeActions: adaptiveResult.activeActions.length }
        : null,
      profitEngine: profitEngineResult
        ? {
            ran: profitEngineResult.ran,
            funnelBlocked: profitEngineResult.funnelBlocked,
            funnelBlockedReason: profitEngineResult.funnelBlockedReason,
            patternsDetected: profitEngineResult.patternsDetected,
            tasksCreated: profitEngineResult.tasksCreated,
            experimentsOpened: profitEngineResult.experimentsOpened,
            winRate: profitEngineResult.winRate,
            avgR: profitEngineResult.avgR,
          }
        : null,
      githubWriteCapability: checkGitHubWriteCapability(),
      ...buildLearningBlock(learningResult, remediationResult, verificationResult, ledgerSummary),
    };

    await storeLatestExecution(batchResponse as Record<string, unknown>);
    await storeLatestBatchExecution(batchResponse as Record<string, unknown>);
    return NextResponse.json(batchResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const result = {
      ok: false,
      error: message,
      dryRun,
      executionStatus: "FAILED" as BatchExecStatus,
      requestedMax,
      executedCount: 0,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      stoppedReason: message,
      results: [] as BatchTaskResult[],
      queueBefore: null,
      queueAfter: null,
      selectedSource: "none" as const,
      selectedTaskId: null,
      selectedTaskTitle: null,
      executionPhases: [phaseResult("RESOLVE_OR_FAIL", "failed", message)] as ExecutionPhaseResult[],
      patchApplied: false,
      commitSha: null,
      verification: { buildOk: false, smokeOk: false, details: {} },
      resolution: { resolved: false, reason: message },
      failure: { phase: "RESOLVE_OR_FAIL", reason: message },
    };
    await storeLatestExecution(result as Record<string, unknown>);
    return NextResponse.json(result, { status: 500 });
  }
}

