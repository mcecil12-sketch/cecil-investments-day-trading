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

// ─── Task types that don't require code patches ─────────────────────

/** OPS and SELF_HEAL task types operate on broker/system state, not code.
 *  They can execute via routeHints (API calls) without fileHints. */
const NON_PATCHABLE_TASK_TYPES = new Set(["OPS", "SELF_HEAL"]);

/** CRITICAL priority tasks should never be blocked by missing fileHints
 *  if they have routeHints - they can execute operationally. */
const CRITICAL_PRIORITY_BYPASS = true;

// ─── Route-based execution for OPS/SELF_HEAL tasks ──────────────────

function resolveBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function buildInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  const cronToken = process.env.CRON_TOKEN ?? process.env.CRON_SECRET ?? "";
  if (cronToken) headers["x-cron-token"] = cronToken;
  return headers;
}

/** Execute an OPS/SELF_HEAL task via route calls instead of code patches.
 *  This is used for operational tasks that interact with broker/system state. */
async function executeRouteBasedTask(
  task: ManualActionTask,
): Promise<ManualTaskExecutionResult> {
  const routes = task.routeHints ?? [];
  if (routes.length === 0) {
    return {
      ok: false,
      patchApplied: false,
      blocked: true,
      blockedReason: "no_route_hints",
      summary: "OPS/SELF_HEAL task has no routeHints to execute",
      failureReason: "no_route_hints",
      fileHints: task.fileHints,
      routeHints: task.routeHints,
    };
  }

  const baseUrl = resolveBaseUrl();
  const headers = buildInternalHeaders();
  const routeResults: Array<{ route: string; ok: boolean; status: number | null; error?: string }> = [];
  let allOk = true;

  for (const route of routes) {
    try {
      // Determine method: POST for action routes, GET for read routes
      const method = route.includes("/execute") || route.includes("/seed") || route.includes("/drain")
        ? "POST"
        : "GET";

      const res = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      const isOk = res.ok || res.status === 200 || res.status === 201;
      routeResults.push({ route, ok: isOk, status: res.status });

      if (!isOk) {
        allOk = false;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      routeResults.push({ route, ok: false, status: null, error: errMsg });
      allOk = false;
    }
  }

  const summary = routeResults
    .map((r) => `${r.route}: ${r.ok ? "OK" : `FAIL(${r.status ?? r.error})`}`)
    .join("; ");

  return {
    ok: allOk,
    patchApplied: false, // Route-based execution doesn't produce commits
    commitSha: null,
    summary: `Route-based execution: ${summary}`,
    verification: {
      buildOk: true, // No build needed for route-based tasks
      smokeOk: allOk, // Routes themselves are the smoke check
      details: { routeResults },
    },
    blocked: false,
    blockedReason: null,
    failureReason: allOk ? null : "route_execution_failed",
    fileHints: task.fileHints,
    routeHints: task.routeHints,
  };
}

// ─── Executor ───────────────────────────────────────────────────────

export async function executeManualTask(
  task: ManualActionTask,
): Promise<ManualTaskExecutionResult> {
  const isNonPatchable = NON_PATCHABLE_TASK_TYPES.has(task.taskType);
  const hasFileHints = task.fileHints && task.fileHints.length > 0;
  const hasRouteHints = task.routeHints && task.routeHints.length > 0;
  const isCritical = task.priority === "CRITICAL";

  // For OPS/SELF_HEAL tasks without fileHints but with routeHints,
  // we can execute via API calls rather than code patches
  if (isNonPatchable && !hasFileHints && hasRouteHints) {
    return executeRouteBasedTask(task);
  }

  // CRITICAL PRIORITY BYPASS: Allow CRITICAL tasks with routeHints to execute
  // even if they have a different taskType and no fileHints
  if (CRITICAL_PRIORITY_BYPASS && isCritical && !hasFileHints && hasRouteHints) {
    console.log("[manual-task-executor] CRITICAL priority bypass - executing via routes", {
      taskId: task.id,
      taskType: task.taskType,
      routeHints: task.routeHints,
    });
    return executeRouteBasedTask(task);
  }

  // 1. Check write capability (only needed for code-patching tasks)
  const ghCapability = checkGitHubWriteCapability();
  if (!ghCapability.writeEnabled) {
    // For non-patchable tasks, this isn't necessarily blocking
    if (isNonPatchable) {
      return {
        ok: false,
        patchApplied: false,
        blocked: true,
        blockedReason: "no_execution_path",
        summary: `OPS/SELF_HEAL task has no fileHints and no routeHints — cannot determine execution path`,
        failureReason: "no_execution_path",
        fileHints: task.fileHints,
        routeHints: task.routeHints,
      };
    }
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

  // 2. Check that patchable tasks have file hints — we need something to commit
  if (!hasFileHints) {
    // Non-patchable tasks without routeHints are blocked (already handled above)
    if (isNonPatchable) {
      return {
        ok: false,
        patchApplied: false,
        blocked: true,
        blockedReason: "no_execution_path",
        summary: `OPS/SELF_HEAL task has no fileHints and no routeHints — cannot determine execution path`,
        failureReason: "no_execution_path",
        fileHints: task.fileHints,
        routeHints: task.routeHints,
      };
    }
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
