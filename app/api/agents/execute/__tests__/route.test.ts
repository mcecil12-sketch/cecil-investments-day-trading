import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listEngineeringTasks: vi.fn(),
  updateEngineeringTaskById: vi.fn(async () => undefined),
  prepareExecutionPlan: vi.fn(() => ({
    patchPlan: {
      mode: "GITHUB_COMMIT",
      targetFiles: ["app/api/agents/execute/route.ts"],
      proposedChangesSummary: "Enable orchestrated execution",
    },
    validationPlan: {
      buildRequired: true,
      testCommands: ["npm run test"],
      smokeChecks: ["GET /api/agents/engineering"],
    },
    commitPlan: {
      commitMessage: "agent: Enable GitHub API write access",
      targetBranch: "main",
      pushDirect: true,
    },
    executionStatus: "READY",
    nextTaskStatus: "READY_FOR_EXECUTION",
  })),
  approveExecution: vi.fn(() => ({ ok: true })),
}));

vi.mock("@/lib/agents/store", () => ({
  listEngineeringTasks: mocks.listEngineeringTasks,
  updateEngineeringTaskById: mocks.updateEngineeringTaskById,
}));

vi.mock("@/lib/agents/execution/engine", () => ({
  prepareExecutionPlan: mocks.prepareExecutionPlan,
}));

vi.mock("@/lib/agents/governance/manager", () => ({
  approveExecution: mocks.approveExecution,
}));

import { POST } from "../route";

describe("POST /api/agents/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_TOKEN = "test-cron-token";
    delete process.env.CRON_SECRET;
  });

  it("returns 401 without a valid x-cron-token", async () => {
    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
      }) as any,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unauthorized",
      message: "Missing or invalid x-cron-token",
    });
  });

  it("returns early when there is no open task", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "No tasks to execute" });
    expect(mocks.updateEngineeringTaskById).not.toHaveBeenCalled();
  });

  it("blocks execution when governance rejects the task", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "OPEN",
        title: "Blocked task",
        summary: "summary",
        likelyFiles: ["lib/agents/governance/manager.ts"],
        copilotPrompt: "rm -rf /",
        smokeTestBlock: "",
        gitBlock: "",
      },
    ]);
    mocks.approveExecution.mockReturnValueOnce({ ok: false, reason: "blocked_pattern_detected" });

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      reason: "blocked_pattern_detected",
      taskId: "task-1",
    });
    expect(mocks.prepareExecutionPlan).not.toHaveBeenCalled();
  });

  it("prepares execution readiness and does not shell out", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "OPEN",
        title: "Enable GitHub API write access",
        summary: "summary",
        likelyFiles: ["app/api/agents/execute/route.ts"],
        copilotPrompt: "Add safe execution engine",
        smokeTestBlock: "curl /api/agents/execute",
        gitBlock: "git push",
        notes: ["seeded by engineering manager"],
      },
    ]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      taskId: "task-1",
      executionStatus: "READY_FOR_EXECUTION",
      commitPlan: { targetBranch: "main", pushDirect: true },
      validationPlan: { buildRequired: true },
    });
    expect(mocks.prepareExecutionPlan).toHaveBeenCalledTimes(1);
    expect(mocks.prepareExecutionPlan).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
    expect(mocks.updateEngineeringTaskById).toHaveBeenCalledTimes(1);
    expect(mocks.updateEngineeringTaskById).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "READY_FOR_EXECUTION",
        executionStatus: "READY",
        executionError: null,
      }),
    );
  });
});