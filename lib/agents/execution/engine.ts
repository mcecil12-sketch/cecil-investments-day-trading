import type {
  CommitPlan,
  EngineeringTask,
  PatchPlan,
  ValidationPlan,
} from "@/lib/agents/types";

export interface PreparedExecutionPlan {
  patchPlan: PatchPlan;
  validationPlan: ValidationPlan;
  commitPlan: CommitPlan;
  executionStatus: "READY";
  nextTaskStatus: "READY_FOR_EXECUTION" | "READY_FOR_PUSH";
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function derivePatchPlan(task: EngineeringTask): PatchPlan {
  if (task.patchPlan) {
    return {
      ...task.patchPlan,
      targetFiles: dedupe(task.patchPlan.targetFiles ?? []),
    };
  }

  return {
    mode: task.likelyFiles.length > 0 ? "GITHUB_COMMIT" : "PLACEHOLDER",
    targetFiles: dedupe(task.likelyFiles),
    proposedChangesSummary: `${task.title}: ${task.summary}`,
  };
}

function deriveValidationPlan(task: EngineeringTask): ValidationPlan {
  if (task.validationPlan) {
    return {
      ...task.validationPlan,
      testCommands: dedupe(task.validationPlan.testCommands ?? []),
      smokeChecks: dedupe(task.validationPlan.smokeChecks ?? []),
    };
  }

  const smokeChecks = dedupe(
    task.smokeTestBlock
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("GET ") || line.startsWith("POST ") || line.startsWith("/api/")),
  );

  return {
    buildRequired: true,
    testCommands: ["npm run test"],
    smokeChecks,
  };
}

function deriveCommitPlan(task: EngineeringTask): CommitPlan {
  if (task.commitPlan) {
    return task.commitPlan;
  }

  return {
    commitMessage: `agent: ${task.title}`,
    targetBranch: "main",
    pushDirect: true,
  };
}

export function prepareExecutionPlan(task: EngineeringTask): PreparedExecutionPlan {
  const patchPlan = derivePatchPlan(task);
  const validationPlan = deriveValidationPlan(task);
  const commitPlan = deriveCommitPlan(task);
  const nextTaskStatus =
    !validationPlan.buildRequired && validationPlan.testCommands.length === 0
      ? "READY_FOR_PUSH"
      : "READY_FOR_EXECUTION";

  return {
    patchPlan,
    validationPlan,
    commitPlan,
    executionStatus: "READY",
    nextTaskStatus,
  };
}