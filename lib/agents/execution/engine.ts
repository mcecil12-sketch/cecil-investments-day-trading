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
  patchPlanSource?: "explicit" | "auto_generated";
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

// ─── Adaptive task → safe patch file mapping ────────────────────────
// Maps keyword patterns to safe, non-execution diagnostic/scoring files.
// NEVER maps to trading execution, order placement, or risk sizing files.

const ADAPTIVE_TASK_FILE_MAP: Array<{ pattern: RegExp; files: string[] }> = [
  {
    pattern: /tier_?c_?high_?loss|tier.?c.?loss|high.?loss.?rate|loss.?clustering/i,
    files: [
      "app/api/performance/summary/route.ts",
      "app/api/funnel-health/route.ts",
      "lib/agents/performanceLearning.ts",
    ],
  },
  {
    pattern: /scoring|ai.?score|score.?improvement|aiScore/i,
    files: [
      "lib/aiScoring.ts",
      "app/api/ai/score/route.ts",
    ],
  },
  {
    pattern: /funnel|underutilized|qualified.?not.?seeded/i,
    files: [
      "app/api/funnel-health/route.ts",
      "lib/funnelMetrics.ts",
    ],
  },
  {
    pattern: /diagnostic|telemetry|metrics|win.?rate|avg.?r/i,
    files: [
      "app/api/agents/state/route.ts",
      "lib/aiMetrics.ts",
    ],
  },
  {
    pattern: /stale.?signal|signal.?filter|fresh.?signal|price.?drift/i,
    files: [
      "lib/signalsStore.ts",
      "lib/signals.ts",
    ],
  },
  {
    pattern: /broker.?mismatch|broker.?sync|position.?sync/i,
    files: [
      "lib/broker/truth.ts",
      "app/api/trades/protection-audit/route.ts",
    ],
  },
];

/**
 * Infer safe diagnostic/scoring target files from task title and summary.
 * Returns a default set of non-execution files when no keyword matches.
 */
function inferTargetFilesFromTask(task: EngineeringTask): string[] {
  const searchText = `${task.title} ${task.summary}`;
  for (const mapping of ADAPTIVE_TASK_FILE_MAP) {
    if (mapping.pattern.test(searchText)) {
      return mapping.files;
    }
  }
  // Default: safe diagnostic files only
  return [
    "app/api/agents/state/route.ts",
    "lib/agents/performanceLearning.ts",
  ];
}

function derivePatchPlan(task: EngineeringTask): { plan: PatchPlan; source: "explicit" | "auto_generated" } {
  // Explicit GITHUB_COMMIT plan — use as-is
  if (task.patchPlan && task.patchPlan.mode === "GITHUB_COMMIT") {
    return {
      plan: {
        ...task.patchPlan,
        targetFiles: dedupe(task.patchPlan.targetFiles ?? []),
      },
      source: "explicit",
    };
  }

  // Upgrade PLACEHOLDER → GITHUB_COMMIT using inferred or explicit files
  const targetFiles =
    task.likelyFiles && task.likelyFiles.length > 0
      ? dedupe(task.likelyFiles)
      : inferTargetFilesFromTask(task);

  const summary =
    task.patchPlan?.proposedChangesSummary ??
    `${task.title}: ${task.summary}`;

  return {
    plan: {
      mode: "GITHUB_COMMIT",
      targetFiles,
      proposedChangesSummary: summary,
    },
    source: "auto_generated",
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
    // Ensure taskId is always in the commit message
    const msg = task.commitPlan.commitMessage?.trim();
    const hasTaskId = msg && msg.includes(task.id);
    return {
      ...task.commitPlan,
      commitMessage: hasTaskId ? msg : `${msg} [taskId:${task.id}]`,
    };
  }

  return {
    commitMessage: `agent: ${task.title} [taskId:${task.id}]`,
    targetBranch: "main",
    pushDirect: true,
  };
}

export function prepareExecutionPlan(task: EngineeringTask): PreparedExecutionPlan {
  const { plan: patchPlan, source: patchPlanSource } = derivePatchPlan(task);
  const validationPlan = deriveValidationPlan(task);
  const commitPlan = deriveCommitPlan(task);

  // Always use READY_FOR_EXECUTION so the batch loop never skips a task
  // that has a valid GITHUB_COMMIT plan + pushDirect commit plan.
  const nextTaskStatus: "READY_FOR_EXECUTION" | "READY_FOR_PUSH" = "READY_FOR_EXECUTION";

  return {
    patchPlan,
    validationPlan,
    commitPlan,
    executionStatus: "READY",
    nextTaskStatus,
    patchPlanSource,
  };
}