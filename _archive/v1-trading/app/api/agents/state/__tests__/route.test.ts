import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAgentReadAuth: vi.fn(async () => ({ ok: true as const })),
  ensureAgentState: vi.fn(async () => ({
    asOf: "2026-04-05T12:00:00Z",
    posture: "NORMAL",
    eventRisk: "LOW",
    newsState: "CALM",
    allowedGrades: ["A", "B", "C"],
    minScoreAdjustment: 0,
    maxEntriesOverride: null,
    freezeWindows: [],
    activeRestrictions: [],
    activeIncidentCount: 0,
    updatedBy: "engineering",
  })),
  readAgentStateSnapshot: vi.fn(async () => ({ source: "stored", state: {} })),
  listEngineeringTasks: vi.fn(),
  readAdaptiveGuardrailState: vi.fn(async () => ({ actions: [], lastEvaluatedAt: null, evaluationSource: null })),
  getActiveActions: vi.fn(() => []),
  getEffectiveMaxOpenPositions: vi.fn((v: number) => v),
  getEffectiveMaxEntriesPerDay: vi.fn((v: number) => v),
  getEffectiveMinScoreAdjustment: vi.fn((v: number) => v),
  getEffectiveCooldownAfterLoss: vi.fn((v: number) => v),
  getSuppressedSides: vi.fn(() => []),
  getGuardrailConfig: vi.fn(() => ({
    maxOpenPositions: 4,
    maxEntriesPerDay: 6,
    cooldownAfterLossMin: 30,
  })),
  checkGitHubWriteCapability: vi.fn(() => ({ writeEnabled: true, reason: null })),
  redisGet: vi.fn(async () => null),
  listManualActionTasks: vi.fn(async () => []),
  countOpenExecutionReadyManualTasks: vi.fn(async () => ({
    openCount: 0,
    executionReadyCount: 0,
    inProgressCount: 0,
    blockedCount: 0,
    selectedCount: 0,
    selectableCount: 0,
    recoverableBlockedCount: 0,
    idleReason: null,
  })),
  getActiveManualTask: vi.fn(async () => null),
  getTrulyActiveManualTask: vi.fn(async () => null),
  getNextQueuedManualTask: vi.fn(async () => null),
  getManualQueueDiagnostics: vi.fn(async () => ({
    totalTasks: 0,
    openCount: 0,
    selectedCount: 0,
    inProgressCount: 0,
    blockedCount: 0,
    failedCount: 0,
    doneCount: 0,
    canceledCount: 0,
    executionReadyCount: 0,
    staleTaskIds: [],
    healthStatus: "healthy",
    healthReason: null,
  })),
}));

vi.mock("@/lib/agents/auth", () => ({
  checkAgentReadAuth: mocks.checkAgentReadAuth,
  unauthorizedAgentResponse: vi.fn((error: string) => Response.json({ ok: false, error }, { status: 401 })),
}));

vi.mock("@/lib/agents/store", () => ({
  ensureAgentState: mocks.ensureAgentState,
  readAgentStateSnapshot: mocks.readAgentStateSnapshot,
  listEngineeringTasks: mocks.listEngineeringTasks,
}));

vi.mock("@/lib/agents/adaptiveGuardrails", () => ({
  readAdaptiveGuardrailState: mocks.readAdaptiveGuardrailState,
  getActiveActions: mocks.getActiveActions,
  getEffectiveMaxOpenPositions: mocks.getEffectiveMaxOpenPositions,
  getEffectiveMaxEntriesPerDay: mocks.getEffectiveMaxEntriesPerDay,
  getEffectiveMinScoreAdjustment: mocks.getEffectiveMinScoreAdjustment,
  getEffectiveCooldownAfterLoss: mocks.getEffectiveCooldownAfterLoss,
  getSuppressedSides: mocks.getSuppressedSides,
}));

vi.mock("@/lib/autoEntry/guardrails", () => ({
  getGuardrailConfig: mocks.getGuardrailConfig,
}));

vi.mock("@/lib/agents/github-write", () => ({
  checkGitHubWriteCapability: mocks.checkGitHubWriteCapability,
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: mocks.redisGet,
  },
}));

vi.mock("@/lib/agents/manual-action-queue", () => ({
  listManualActionTasks: mocks.listManualActionTasks,
  countOpenExecutionReadyManualTasks: mocks.countOpenExecutionReadyManualTasks,
  getActiveManualTask: mocks.getActiveManualTask,
  getTrulyActiveManualTask: mocks.getTrulyActiveManualTask,
  getNextQueuedManualTask: mocks.getNextQueuedManualTask,
  getManualQueueDiagnostics: mocks.getManualQueueDiagnostics,
}));

import { GET } from "../route";

describe("GET /api/agents/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENT_AUTONOMY_ENABLED = "1";
    process.env.AGENT_MAX_TASKS_PER_RUN = "3";
  });

  it("derives state execution counts directly from engineering queue", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "open-1",
        createdAt: "2026-04-05T09:00:00Z",
        updatedAt: "2026-04-05T09:00:00Z",
        status: "OPEN",
        title: "Open task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
      },
      {
        id: "ready-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Ready task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
        executionStatus: "READY",
      },
      {
        id: "blocked-1",
        createdAt: "2026-04-05T11:00:00Z",
        updatedAt: "2026-04-05T11:00:00Z",
        status: "BLOCKED",
        title: "Blocked task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
      },
    ]);

    const response = await GET(new Request("http://localhost/api/agents/state"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.state.openEngineeringTaskCount).toBe(3);
    expect(body.state.openExecutionReadyCount).toBe(1);
    expect(body.state.blockedTaskCount).toBe(1);
    expect(body.state.latestExecutionTaskTitle).toBe("Ready task");
    expect(body.state.latestExecutionStatus).toBe("READY");
    expect(body.state.autonomyEnabled).toBe(true);
    expect(body.state.lastBatchExecutedCount).toBe(0);
    expect(body.state.lastBatchCompletedCount).toBe(0);
    expect(body.state.lastBatchFailedCount).toBe(0);
    expect(Array.isArray(body.state.nextSelectableTasks)).toBe(true);
    expect(body.state.queueThroughput).toMatchObject({
      lastBatchExecutedCount: 0,
      lastBatchCompletedCount: 0,
      lastBatchFailedCount: 0,
    });
  });
});
