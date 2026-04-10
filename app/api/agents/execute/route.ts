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
import { getCriticalTasks } from "@/lib/redis";
import { runSafeExecutionGate, type GateResult } from "@/lib/agents/safe-execution-gate";
import { resolveWithVerification, setAttemptMetadata } from "@/lib/agents/incident-resolution";
import { runIncidentResolver, type ActionResult } from "@/lib/agents/resolvers";
import type { EngineeringTask } from "@/lib/agents/types";

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

async function executeReadyForGithubCommit(task: EngineeringTask) {
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
      console.warn(`[execute] Pre-commit smoke validation failed for task ${task.id}: ${validationFailureReason}`);
    }
  } catch {
    // non-fatal — validation errors don't block execution
  }

  if (!validationPassed && validationFailureReason) {
    // Queue a narrower remediation instead of blocking entirely; mark as noted
    const blockedNotes = appendNotes(task.notes, [
      `Pre-commit validation failed: ${validationFailureReason}`,
      "Proceeding with execution — smoke check failure is advisory in Phase 3.",
    ]);
    await updateEngineeringTaskById(task.id, { notes: blockedNotes });
  }

  const executionResult = await executeGithubTask(task);

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

  // Phase 3: close impact envelope after execution
  if (envelopeId) {
    try {
      await closeImpactEnvelope(envelopeId, executionResult.commitSha ?? null);
    } catch {
      // non-fatal
    }
  }

  return NextResponse.json({
    ok: true,
    executedTaskId: task.id,
    executionStatus: "EXECUTED",
    filesTouched: executionResult.filesTouched,
    commitMessage: executionResult.commitMessage,
    commitSha: executionResult.commitSha,
    commitUrl: executionResult.commitUrl,
  });
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

  let task: EngineeringTask | null = null;

  try {
    // ─── Critical Task Batch Drain ────────────────────────────────────
    // When unresolved protection incidents exist, attempt to resolve all
    // eligible critical tasks in one run (capped for safety).
    const criticalTasks = await getCriticalTasks().catch(() => []);
    if (criticalTasks.length > 0) {
      const MAX_PER_RUN = Math.max(1, Math.min(20, Number(process.env.MAX_CRITICAL_RESOLUTIONS_PER_RUN) || 5));
      const batch = criticalTasks.slice(0, MAX_PER_RUN);

      console.log(`[execute] Critical batch start: ${batch.length}/${criticalTasks.length} tasks, cap=${MAX_PER_RUN}`);

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
        // Record attempt metadata for each task
        for (const ct of batch) {
          await setAttemptMetadata(ct.id, {
            lastAttemptAt: new Date().toISOString(),
            lastAttemptResult: "failure",
            lastVerificationResult: "skipped",
            lastVerificationReason: gateResult.failureReason ?? "gate_failed",
          }).catch(() => {});
        }

        return NextResponse.json({
          ok: true,
          message: "Execution blocked: safe execution gate failed",
          criticalBypassApplied: true,
          selectedSource: "critical-task-queue",
          executionStatus: "BYPASSED_CRITICAL",
          criticalTaskCount: criticalTasks.length,
          attemptedCriticalCount: 0,
          resolvedCriticalCount: 0,
          failedCriticalCount: 0,
          skippedCriticalCount: batch.length,
          remainingCriticalCount: criticalTasks.length,
          criticalResolutionResults: batch.map((ct) => ({
            id: ct.id,
            incidentCode: ct.incidentCode,
            symbol: ct.symbol,
            status: "skipped" as const,
            reason: gateResult!.failureReason ?? "gate_failed",
          })),
          safeExecutionGate: gateResult,
        });
      }

      // Gate passed — attempt resolution for each task
      type ItemResult = {
        id: string;
        incidentCode: string;
        symbol: string;
        status: "resolved" | "failed" | "skipped";
        reason: string | null;
        action?: ActionResult;
      };
      const results: ItemResult[] = [];
      let resolvedCount = 0;
      let failedCount = 0;

      for (const ct of batch) {
        try {
          // 1. Run real corrective action
          const actionResult = await runIncidentResolver(ct);
          console.log(`[execute] resolver result for ${ct.id}:`, {
            action: actionResult.action,
            ok: actionResult.ok,
            attempted: actionResult.attempted,
          });

          // 2. If action failed, record and continue (don't verify)
          if (actionResult.attempted && !actionResult.ok) {
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

          // 3. Action succeeded (or was not needed) — run verification
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

      const remainingCount = criticalTasks.length - resolvedCount;
      const allResolved = remainingCount === 0;

      console.log(`[execute] Critical batch done: resolved=${resolvedCount} failed=${failedCount} remaining=${remainingCount}`);

      return NextResponse.json({
        ok: true,
        message: allResolved
          ? "All critical incidents resolved after verification"
          : `Resolved ${resolvedCount}/${batch.length} critical incidents`,
        criticalBypassApplied: true,
        selectedSource: "critical-task-queue",
        executionStatus: allResolved ? "CRITICAL_BATCH_RESOLVED" : resolvedCount > 0 ? "CRITICAL_BATCH_PARTIAL" : "BYPASSED_CRITICAL",
        criticalTaskCount: criticalTasks.length,
        attemptedCriticalCount: batch.length,
        resolvedCriticalCount: resolvedCount,
        failedCriticalCount: failedCount,
        skippedCriticalCount: 0,
        remainingCriticalCount: remainingCount,
        criticalResolutionResults: results,
        safeExecutionGate: gateResult,
      });
    }

    const tasks = await listEngineeringTasks(100);
    task = tasks
      .filter((candidate) => isEligibleTask(candidate))
      .sort((a, b) => executionSortRank(a) - executionSortRank(b))[0] ?? null;

    if (!task) {
      return NextResponse.json({ ok: true, message: "No execution-ready tasks" });
    }

    if (task.status === "READY_FOR_EXECUTION") {
      const guardrailError = validateExecutionGuardrails(task);

      if (guardrailError) {
        const skippedNotes = appendNotes(task.notes, [`Execution skipped: ${guardrailError}`]);
        await updateEngineeringTaskById(task.id, {
          notes: skippedNotes,
          executionError: guardrailError,
        });

        return NextResponse.json({
          ok: true,
          taskId: task.id,
          executionStatus: task.executionStatus ?? "READY",
          skipped: true,
          reason: guardrailError,
        });
      }

      try {
        return await executeReadyForGithubCommit(task);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await blockExecution(task, message);

        return NextResponse.json(
          {
            ok: false,
            error: message,
            taskId: task.id,
            executionStatus: "FAILED",
          },
          { status: 500 },
        );
      }
    }

    const approval = task.status === "OPEN" ? approveExecution(task) : { ok: true as const };

    if (!approval.ok) {
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

      return NextResponse.json(
        {
          ok: false,
          reason: approval.reason,
          taskId: task.id,
          executionStatus: "BLOCKED",
        },
        { status: 403 },
      );
    }

    const prepared = prepareExecutionPlan(task);
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
        await updateEngineeringTaskById(task.id, {
          notes: appendNotes(preparedTask.notes, [`Execution skipped: ${guardrailError}`]),
          executionError: guardrailError,
        });

        return NextResponse.json({
          ok: true,
          taskId: task.id,
          executionStatus: preparedTask.executionStatus ?? "READY",
          skipped: true,
          reason: guardrailError,
        });
      }

      try {
        return await executeReadyForGithubCommit(preparedTask);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await blockExecution(preparedTask, message);
        return NextResponse.json(
          {
            ok: false,
            error: message,
            taskId: task.id,
            executionStatus: "FAILED",
          },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({
      ok: true,
      taskId: task.id,
      executionStatus: prepared.nextTaskStatus,
      patchPlan: prepared.patchPlan,
      validationPlan: prepared.validationPlan,
      commitPlan: prepared.commitPlan,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markExecutionFailure(task, message);

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 },
    );
  }
}