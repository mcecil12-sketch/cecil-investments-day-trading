/**
 * Manual Task Executor — translates a ManualActionTask into the
 * existing patch-capable agent execution path.
 *
 * Reuses the GitHub write flow / patch executor when available.
 * Never fakes success — returns blocked when wiring is unavailable.
 */

import { checkGitHubWriteCapability } from "@/lib/agents/github-write";
import { executeGithubTask, type GithubExecutionResult } from "@/lib/agents/githubExecutor";
import { runStructuredVerification } from "@/lib/agents/verification-runner";
import type { ManualActionTask } from "@/lib/agents/manual-action-queue";
import type { EngineeringTask, PatchPlan, CommitPlan, ValidationPlan } from "@/lib/agents/types";

// ─── Result shape ───────────────────────────────────────────────────

export interface ManualTaskExecutionResult {
  ok: boolean;
  patchApplied: boolean;
  commitSha?: string | null;
  summary: string;
  verification?: {
    buildOk?: boolean;
    smokeOk?: boolean;
    details?: Record<string, unknown>;
  };
  blocked?: boolean;
  blockedReason?: string | null;
  failureReason?: string | null;
  fileHints?: string[];
  routeHints?: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Convert a ManualActionTask into the EngineeringTask shape the
 *  existing executor expects. Only fields needed for execution are set. */
function toEngineeringTask(task: ManualActionTask): EngineeringTask {
  const patchPlan: PatchPlan = {
    mode: "GITHUB_COMMIT",
    targetFiles: task.fileHints ?? [],
    proposedChangesSummary: task.description,
  };

  const commitPlan: CommitPlan = {
    commitMessage: `agent: ${task.title}`,
    targetBranch: "main",
    pushDirect: true,
  };

  const smokeRoutes = (task.routeHints ?? [])
    .filter((r) => r.startsWith("/api/"))
    .join("\n");

  const validationPlan: ValidationPlan = {
    buildRequired: true,
    testCommands: [],
    smokeChecks: task.routeHints ?? ["/api/readiness"],
  };

  return {
    id: task.id,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    status: "READY_FOR_EXECUTION",
    title: task.title,
    summary: task.description,
    likelyFiles: task.fileHints ?? [],
    copilotPrompt: task.objective ?? task.description,
    smokeTestBlock: smokeRoutes || "GET /api/readiness",
    gitBlock: "",
    patchPlan,
    commitPlan,
    validationPlan,
    executionStatus: "READY",
  };
}

// ─── Executor ───────────────────────────────────────────────────────

export async function executeManualTask(
  task: ManualActionTask,
): Promise<ManualTaskExecutionResult> {
  // 1. Check write capability
  const ghCapability = checkGitHubWriteCapability();
  if (!ghCapability.writeEnabled) {
    return {
      ok: false,
      patchApplied: false,
      blocked: true,
      blockedReason: "patch_executor_unavailable",
      summary: `GitHub write not available: ${ghCapability.reason}`,
      failureReason: ghCapability.reason ?? "github_write_disabled",
      fileHints: task.fileHints,
      routeHints: task.routeHints,
    };
  }

  // 2. Check that the task has file hints — we need something to commit
  if (!task.fileHints || task.fileHints.length === 0) {
    return {
      ok: false,
      patchApplied: false,
      blocked: true,
      blockedReason: "no_file_hints",
      summary: "Task has no fileHints — cannot determine patch targets",
      failureReason: "no_file_hints",
      fileHints: task.fileHints,
      routeHints: task.routeHints,
    };
  }

  // 3. Convert to engineering task form and execute
  const engineeringTask = toEngineeringTask(task);
  let executionResult: GithubExecutionResult;
  try {
    executionResult = await executeGithubTask(engineeringTask);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      patchApplied: false,
      blocked: false,
      summary: `Patch execution failed: ${errMsg}`,
      failureReason: errMsg,
      fileHints: task.fileHints,
      routeHints: task.routeHints,
    };
  }

  // 4. Run verification
  let verification: ManualTaskExecutionResult["verification"] = {
    buildOk: true,
    smokeOk: true,
    details: {},
  };
  try {
    const vResult = await runStructuredVerification(engineeringTask);
    verification = {
      buildOk: vResult.gateResult.buildOk,
      smokeOk: vResult.gateResult.smokeOk,
      details: {
        probes: vResult.probeResults,
        taskSpecific: vResult.taskSpecificResults,
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    verification = {
      buildOk: false,
      smokeOk: false,
      details: { error: errMsg },
    };
  }

  const verificationPassed = verification.buildOk === true && verification.smokeOk === true;

  return {
    ok: verificationPassed,
    patchApplied: executionResult.success,
    commitSha: executionResult.commitSha ?? null,
    summary: verificationPassed
      ? `Executed: ${executionResult.filesTouched.join(", ")} — commit ${executionResult.commitSha ?? "unknown"}`
      : `Executed but verification failed — commit ${executionResult.commitSha ?? "unknown"}`,
    verification,
    blocked: false,
    blockedReason: null,
    failureReason: verificationPassed ? null : "post_commit_verification_failed",
    fileHints: task.fileHints,
    routeHints: task.routeHints,
  };
}
