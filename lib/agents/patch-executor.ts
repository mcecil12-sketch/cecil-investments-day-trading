/**
 * Patch Executor — Phase 4
 *
 * Converts a selected engineering task into a structured, machine-consumable
 * patch plan and prepares it for execution.
 */

import type {
  EngineeringTask,
  PatchPlanDetail,
  ActionableBacklogTask,
  ScoredTask,
} from "@/lib/agents/types";

// ─── Patch Plan Generation ──────────────────────────────────────────

export function generatePatchPlan(task: EngineeringTask): PatchPlanDetail {
  const targetFiles = [
    ...(task.patchPlan?.targetFiles ?? []),
    ...(task.likelyFiles ?? []),
  ].filter(Boolean);
  const dedupedFiles = [...new Set(targetFiles)];

  const smokeChecks = task.smokeTestBlock
    ? task.smokeTestBlock
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("GET ") || l.startsWith("POST ") || l.startsWith("/api/"))
    : [];

  const validationSteps = [
    ...(task.validationPlan?.testCommands ?? []),
    ...(task.validationPlan?.smokeChecks ?? []),
    ...smokeChecks,
  ].filter(Boolean);
  const dedupedValidation = [...new Set(validationSteps)];

  const diffType: PatchPlanDetail["expectedDiffType"] =
    task.patchPlan?.mode === "GITHUB_COMMIT"
      ? "code_change"
      : task.patchPlan?.mode === "FILE_WRITE"
        ? "config_change"
        : "ops_only";

  return {
    summary: task.patchPlan?.proposedChangesSummary ?? `${task.title}: ${task.summary}`,
    filesToModify: dedupedFiles,
    expectedDiffType: diffType,
    validationSteps: dedupedValidation,
    rollbackNotes: task.commitPlan
      ? `Revert commit ${task.commitPlan.commitMessage} on ${task.commitPlan.targetBranch}`
      : "Revert the applied changes manually or via a follow-up task.",
  };
}

// ─── Task Classification ────────────────────────────────────────────

export function classifyTaskAsActionable(
  task: EngineeringTask,
  scored?: ScoredTask,
): ActionableBacklogTask {
  const hasGithubPatch =
    task.patchPlan?.mode === "GITHUB_COMMIT" &&
    task.commitPlan?.pushDirect === true &&
    !!task.commitPlan?.commitMessage?.trim();

  const targetFiles = [
    ...(task.patchPlan?.targetFiles ?? []),
    ...(task.likelyFiles ?? []),
  ].filter(Boolean);

  const smokeTargets = task.smokeTestBlock
    ? task.smokeTestBlock
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/api/") || l.startsWith("GET ") || l.startsWith("POST "))
    : ["/api/readiness", "/api/trades/protection-audit"];

  const successCriteria = task.successCriteria
    ? [task.successCriteria]
    : [`Task ${task.id} completes without build or smoke failures`];

  const patchStrategy: ActionableBacklogTask["patchStrategy"] =
    task.patchPlan?.mode === "GITHUB_COMMIT"
      ? "code_change"
      : task.patchPlan?.mode === "FILE_WRITE"
        ? "config_change"
        : "ops_only";

  return {
    id: task.id,
    title: task.title,
    category: task.incidentCategory ?? "ENGINEERING",
    priorityBucket: scored?.priorityBucket ?? "MEDIUM",
    executionReady: hasGithubPatch,
    patchStrategy,
    targetFiles: [...new Set(targetFiles)],
    smokeTargets: [...new Set(smokeTargets)],
    successCriteria,
  };
}
