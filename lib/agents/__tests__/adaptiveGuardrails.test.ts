import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdaptiveGuardrailAction,
  AdaptiveGuardrailState,
  PerformanceLearningSignals,
} from "@/lib/agents/types";

// ─── Mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  readPerformanceLearning: vi.fn(),
  appendEngineeringTask: vi.fn(async (t: any) => t),
}));

vi.mock("@/lib/redis", () => ({
  redis: { get: mocks.redisGet, set: mocks.redisSet },
  getCriticalTasks: vi.fn(async () => []),
}));

vi.mock("@/lib/redis/ttl", () => ({
  getTtlSeconds: () => 86400,
  setWithTtl: vi.fn(),
}));

vi.mock("@/lib/agents/performanceLearning", () => ({
  readPerformanceLearning: mocks.readPerformanceLearning,
}));

vi.mock("@/lib/agents/store", () => ({
  appendEngineeringTask: mocks.appendEngineeringTask,
}));

vi.mock("@/lib/agents/time", () => ({
  nowIso: () => "2026-04-11T14:00:00Z",
}));

import {
  evaluateAdaptiveGuardrails,
  readAdaptiveGuardrailState,
  getActiveActions,
  getEffectiveMaxOpenPositions,
  getEffectiveMaxEntriesPerDay,
  getEffectiveMinScoreAdjustment,
  getEffectiveCooldownAfterLoss,
  getSuppressedSides,
  rollbackAction,
} from "@/lib/agents/adaptiveGuardrails";

// ─── Helpers ────────────────────────────────────────────────────────

function makeSignals(overrides: Partial<PerformanceLearningSignals> = {}): PerformanceLearningSignals {
  return {
    computedAt: "2026-04-11T12:00:00Z",
    tradePeriodDays: 30,
    totalTrades: 20,
    winRate: 0.5,
    avgR: 0.3,
    longWinRate: 0.5,
    shortWinRate: 0.5,
    deepLossCount: 0,
    deepLossRate: 0.0,
    losingPatterns: [],
    winningPatterns: [],
    longVsShortImbalance: "balanced",
    weakSetupClasses: [],
    recommendedCorrections: [],
    growthOpportunities: [],
    ...overrides,
  };
}

function makeAction(overrides: Partial<AdaptiveGuardrailAction> = {}): AdaptiveGuardrailAction {
  return {
    id: "test-action-1",
    actionType: "reduce_max_open_positions",
    reason: "test",
    triggerPattern: "test_pattern",
    appliedAt: "2026-04-11T14:00:00Z",
    expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
    status: "ACTIVE",
    previousValue: null,
    appliedValue: 2,
    rolledBackAt: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Adaptive Guardrails Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue(undefined);
  });

  describe("evaluateAdaptiveGuardrails", () => {
    it("returns unevaluated when insufficient trade data", async () => {
      mocks.readPerformanceLearning.mockResolvedValue(makeSignals({ totalTrades: 3 }));

      const result = await evaluateAdaptiveGuardrails();

      expect(result.evaluated).toBe(false);
      expect(result.actionsApplied).toHaveLength(0);
      expect(result.tasksCreated).toHaveLength(0);
    });

    it("detects deep_loss_rate_elevated and applies reduce_max_open_positions", async () => {
      mocks.readPerformanceLearning.mockResolvedValue(
        makeSignals({ totalTrades: 10, deepLossRate: 0.25, deepLossCount: 3 }),
      );

      const result = await evaluateAdaptiveGuardrails();

      expect(result.evaluated).toBe(true);
      const posAction = result.actionsApplied.find(
        (a) => a.actionType === "reduce_max_open_positions",
      );
      expect(posAction).toBeDefined();
      expect(posAction!.appliedValue).toBe(2);
      expect(posAction!.triggerPattern).toBe("deep_loss_rate_elevated");
      expect(posAction!.status).toBe("ACTIVE");
      expect(posAction!.expiresAt).toBeTruthy();
    });

    it("detects low win rate and applies raise_min_score_threshold", async () => {
      mocks.readPerformanceLearning.mockResolvedValue(
        makeSignals({ totalTrades: 12, winRate: 0.35 }),
      );

      const result = await evaluateAdaptiveGuardrails();

      expect(result.evaluated).toBe(true);
      const scoreAction = result.actionsApplied.find(
        (a) => a.actionType === "raise_min_score_threshold",
      );
      expect(scoreAction).toBeDefined();
      expect(scoreAction!.appliedValue).toBe(1.0);
    });

    it("detects negative avgR and applies reduce_max_entries_per_day", async () => {
      mocks.readPerformanceLearning.mockResolvedValue(
        makeSignals({ totalTrades: 8, avgR: -0.5 }),
      );

      const result = await evaluateAdaptiveGuardrails();

      const entryAction = result.actionsApplied.find(
        (a) => a.actionType === "reduce_max_entries_per_day",
      );
      expect(entryAction).toBeDefined();
      expect(entryAction!.appliedValue).toBe(3);
    });

    it("suppresses long side when underperforming", async () => {
      mocks.readPerformanceLearning.mockResolvedValue(
        makeSignals({
          totalTrades: 10,
          longVsShortImbalance: "long_underperforming_materially",
        }),
      );

      const result = await evaluateAdaptiveGuardrails();

      const sideAction = result.actionsApplied.find((a) => a.actionType === "suppress_side");
      expect(sideAction).toBeDefined();
      expect(sideAction!.appliedValue).toBe("suppress_long");
    });

    it("creates tasks for non-safe patterns instead of auto-applying", async () => {
      mocks.readPerformanceLearning.mockResolvedValue(
        makeSignals({ totalTrades: 20, winRate: 0.25 }),
      );

      const result = await evaluateAdaptiveGuardrails();

      expect(result.tasksCreated.length).toBeGreaterThan(0);
      expect(mocks.appendEngineeringTask).toHaveBeenCalled();
      const taskArg = mocks.appendEngineeringTask.mock.calls[0][0];
      expect(taskArg.title).toContain("[Adaptive]");
      expect(taskArg.summary).toContain("scoring_quality_degraded");
    });

    it("does not duplicate actions for already active patterns", async () => {
      const existingState: AdaptiveGuardrailState = {
        actions: [
          makeAction({
            triggerPattern: "deep_loss_rate_elevated",
            actionType: "reduce_max_open_positions",
          }),
        ],
        lastEvaluatedAt: "2026-04-11T13:00:00Z",
        evaluationSource: "performance_learning",
      };
      mocks.redisGet.mockResolvedValue(JSON.stringify(existingState));
      mocks.readPerformanceLearning.mockResolvedValue(
        makeSignals({ totalTrades: 10, deepLossRate: 0.25, deepLossCount: 3 }),
      );

      const result = await evaluateAdaptiveGuardrails();

      const posActions = result.actionsApplied.filter(
        (a) => a.triggerPattern === "deep_loss_rate_elevated",
      );
      expect(posActions).toHaveLength(0);
    });

    it("expires old actions on evaluation", async () => {
      const expiredAction = makeAction({
        id: "expired-1",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const existingState: AdaptiveGuardrailState = {
        actions: [expiredAction],
        lastEvaluatedAt: "2026-04-11T10:00:00Z",
        evaluationSource: "performance_learning",
      };
      mocks.redisGet.mockResolvedValue(JSON.stringify(existingState));
      mocks.readPerformanceLearning.mockResolvedValue(makeSignals({ totalTrades: 6 }));

      const result = await evaluateAdaptiveGuardrails();

      expect(result.expiredActions).toContain("expired-1");
    });
  });

  describe("getActiveActions", () => {
    it("returns only ACTIVE non-expired actions", () => {
      const state: AdaptiveGuardrailState = {
        actions: [
          makeAction({ id: "a1", status: "ACTIVE" }),
          makeAction({ id: "a2", status: "EXPIRED" }),
          makeAction({
            id: "a3",
            status: "ACTIVE",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          }),
          makeAction({ id: "a4", status: "ROLLED_BACK" }),
        ],
        lastEvaluatedAt: null,
        evaluationSource: null,
      };

      const active = getActiveActions(state);
      expect(active.map((a) => a.id)).toEqual(["a1"]);
    });
  });

  describe("effective guardrail calculations", () => {
    it("getEffectiveMaxOpenPositions returns min of base and actions", () => {
      const actions = [makeAction({ actionType: "reduce_max_open_positions", appliedValue: 2 })];
      expect(getEffectiveMaxOpenPositions(5, actions)).toBe(2);
      expect(getEffectiveMaxOpenPositions(1, actions)).toBe(1);
      expect(getEffectiveMaxOpenPositions(5, [])).toBe(5);
    });

    it("getEffectiveMaxEntriesPerDay returns min of base and actions", () => {
      const actions = [makeAction({ actionType: "reduce_max_entries_per_day", appliedValue: 3 })];
      expect(getEffectiveMaxEntriesPerDay(8, actions)).toBe(3);
      expect(getEffectiveMaxEntriesPerDay(2, actions)).toBe(2);
    });

    it("getEffectiveMinScoreAdjustment returns max adjustment", () => {
      const actions = [makeAction({ actionType: "raise_min_score_threshold", appliedValue: 1.5 })];
      expect(getEffectiveMinScoreAdjustment(0, actions)).toBe(1.5);
      expect(getEffectiveMinScoreAdjustment(2.0, actions)).toBe(2.0);
    });

    it("getEffectiveCooldownAfterLoss returns max cooldown", () => {
      const actions = [
        makeAction({ actionType: "increase_cooldown_after_loss", appliedValue: 40 }),
      ];
      expect(getEffectiveCooldownAfterLoss(20, actions)).toBe(40);
      expect(getEffectiveCooldownAfterLoss(60, actions)).toBe(60);
    });

    it("getSuppressedSides returns suppressed sides", () => {
      const actions = [
        makeAction({ actionType: "suppress_side", appliedValue: "suppress_long" }),
        makeAction({ actionType: "suppress_side", appliedValue: "suppress_short" }),
      ];
      expect(getSuppressedSides(actions)).toEqual(["LONG", "SHORT"]);
      expect(getSuppressedSides([])).toEqual([]);
    });
  });

  describe("rollbackAction", () => {
    it("rolls back an active action", async () => {
      const state: AdaptiveGuardrailState = {
        actions: [makeAction({ id: "rb-1" })],
        lastEvaluatedAt: null,
        evaluationSource: null,
      };
      mocks.redisGet.mockResolvedValue(JSON.stringify(state));

      const result = await rollbackAction("rb-1");

      expect(result).toBe(true);
      expect(mocks.redisSet).toHaveBeenCalled();
      const stored = JSON.parse(mocks.redisSet.mock.calls[0][1]);
      expect(stored.actions[0].status).toBe("ROLLED_BACK");
      expect(stored.actions[0].rolledBackAt).toBeTruthy();
    });

    it("returns false for non-existent action", async () => {
      mocks.redisGet.mockResolvedValue(null);
      const result = await rollbackAction("nonexistent");
      expect(result).toBe(false);
    });
  });
});

describe("Patch Executor", () => {
  it("generates structured patch plan from task", async () => {
    const { generatePatchPlan } = await import("@/lib/agents/patch-executor");

    const plan = generatePatchPlan({
      id: "task-1",
      createdAt: "2026-04-11T14:00:00Z",
      updatedAt: "2026-04-11T14:00:00Z",
      status: "READY_FOR_EXECUTION",
      title: "Fix scoring bug",
      summary: "Scoring returns wrong values",
      likelyFiles: ["lib/aiScoring.ts"],
      copilotPrompt: "",
      smokeTestBlock: "GET /api/readiness",
      gitBlock: "",
      patchPlan: {
        mode: "GITHUB_COMMIT",
        targetFiles: ["lib/aiScoring.ts"],
        proposedChangesSummary: "Fix scoring calculation",
      },
      validationPlan: {
        buildRequired: true,
        testCommands: ["npm test"],
        smokeChecks: ["GET /api/agents/state"],
      },
      commitPlan: {
        commitMessage: "fix: scoring calculation",
        targetBranch: "main",
        pushDirect: true,
      },
    });

    expect(plan.summary).toBe("Fix scoring calculation");
    expect(plan.filesToModify).toContain("lib/aiScoring.ts");
    expect(plan.expectedDiffType).toBe("code_change");
    expect(plan.validationSteps.length).toBeGreaterThan(0);
    expect(plan.rollbackNotes).toContain("Revert commit");
  });

  it("classifies task as actionable with correct fields", async () => {
    const { classifyTaskAsActionable } = await import("@/lib/agents/patch-executor");

    const result = classifyTaskAsActionable({
      id: "task-2",
      createdAt: "2026-04-11T14:00:00Z",
      updatedAt: "2026-04-11T14:00:00Z",
      status: "READY_FOR_EXECUTION",
      title: "Enable auto-close",
      summary: "summary",
      likelyFiles: ["lib/autoManage.ts"],
      copilotPrompt: "",
      smokeTestBlock: "/api/readiness",
      gitBlock: "",
      patchPlan: {
        mode: "GITHUB_COMMIT",
        targetFiles: ["lib/autoManage.ts"],
        proposedChangesSummary: "Enable feature",
      },
      commitPlan: {
        commitMessage: "feat: enable auto-close",
        targetBranch: "main",
        pushDirect: true,
      },
    });

    expect(result.id).toBe("task-2");
    expect(result.executionReady).toBe(true);
    expect(result.patchStrategy).toBe("code_change");
    expect(result.targetFiles).toContain("lib/autoManage.ts");
    expect(result.smokeTargets.length).toBeGreaterThan(0);
    expect(result.successCriteria.length).toBeGreaterThan(0);
  });

  it("marks task not executionReady when no GITHUB_COMMIT plan", async () => {
    const { classifyTaskAsActionable } = await import("@/lib/agents/patch-executor");

    const result = classifyTaskAsActionable({
      id: "task-3",
      createdAt: "2026-04-11T14:00:00Z",
      updatedAt: "2026-04-11T14:00:00Z",
      status: "OPEN",
      title: "Review scoring prompt",
      summary: "Manual review needed",
      likelyFiles: [],
      copilotPrompt: "",
      smokeTestBlock: "",
      gitBlock: "",
    });

    expect(result.executionReady).toBe(false);
    expect(result.patchStrategy).toBe("ops_only");
  });
});

describe("GitHub Write Capability", () => {
  it("reports writeEnabled:false when env vars are missing", async () => {
    const { checkGitHubWriteCapability } = await import("@/lib/agents/github-write");

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_INSTALLATION_ID;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;

    const result = checkGitHubWriteCapability();
    expect(result.writeEnabled).toBe(false);
    expect(result.reason).toContain("Missing env vars");
  });

  it("reports writeEnabled:true when all env vars present", async () => {
    const { checkGitHubWriteCapability } = await import("@/lib/agents/github-write");

    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "key";
    process.env.GITHUB_INSTALLATION_ID = "456";
    process.env.GITHUB_REPO_OWNER = "owner";
    process.env.GITHUB_REPO_NAME = "repo";

    const result = checkGitHubWriteCapability();
    expect(result.writeEnabled).toBe(true);

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_INSTALLATION_ID;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
  });

  it("generates safe branch names", async () => {
    const { getGitHubBranchName } = await import("@/lib/agents/github-write");
    const branch = getGitHubBranchName("task-abc-12345678");
    expect(branch).toMatch(/^agent\/task-abc-123-\d{8}$/);
  });
});
